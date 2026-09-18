// api/explain.js
// サーバー側でだけ動く関数。APIキーはここでしか使わないので、ブラウザに漏れない。
// 使用制限：①1人1日あたり ②全員合わせて1日あたり。加えてAnthropic側の残高が最終的な壁。
//
// 【先読み設計】"full" 1回で、総括・まとまり・全行・主要単語の説明をまとめて生成する。
// これによりクリックのたびにAPIを呼ばずに済み、呼び出し回数を大きく減らせる。
// ("line"/"word" は、先読みに漏れた分の予備として都度でも呼べるよう残してある)

const HITS = new Map();          // ip -> { day, count }
const DAILY_LIMIT = 15;          // ①1人1日あたりの上限
const GLOBAL_DAILY_LIMIT = 100;  // ②全員合わせて1日あたりの上限
let GLOBAL = { day: '', count: 0 };

function today() { return new Date().toISOString().slice(0, 10); }
function overGlobal() {
  const t = today();
  if (GLOBAL.day !== t) { GLOBAL = { day: t, count: 0 }; }
  if (GLOBAL.count >= GLOBAL_DAILY_LIMIT) return true;
  GLOBAL.count++; return false;
}
function overLimit(ip) {
  const t = today();
  const rec = HITS.get(ip);
  if (!rec || rec.day !== t) { HITS.set(ip, { day: t, count: 1 }); return false; }
  if (rec.count >= DAILY_LIMIT) return true;
  rec.count++; return false;
}

// 共通の言葉づかいルール（全ての説明で守る）
const STYLE = `
【言葉づかい・共通ルール】
- 分類や正体ではなく、実行したら「実際に何が起きるか」を言う。
- 敬語（です・ます）で書く。「あ、これ〜だ」のようなくだけたセリフや擬人化は禁止。丁寧だが直接的に。
- 専門用語（処理・宣言・定義・入力・変数・関数・引数・非同期など）や、かたい漢語（送信・状態・管理・警告など）は避け、やさしい言葉に開く。例：文字列→文章、サーバー→よそ/相手先、処理結果→返ってきた答え。
- 比喩（箱など）や「おまじない」のような逃げの表現、コード内の名前をそのまま出すことは避ける。`;

// 先読み：全部まとめて1回で返す
const SYSTEM_FULL = `あなたはコードを読む人に、コードの意味をやさしく教えます。渡されたコード全体について、次の4種類の説明を一度にまとめて作ってください。
${STYLE}

【① 全体の総括(overview)】
- guess：作り手が何を作ろうとしているかの推測を、短く1文で。推測なので必ず「〜だと思われます」「〜のようです」と控えめに。動作の詳細はここに混ぜない。
- action：実行すると実際に何が起きるかを、1〜2文でやさしく。

【② まとまり(chunks)】
- 続きの数行が1つの目的でつながっているなら1つにまとめる。目的が変わったら次のまとまり。1まとまり1〜6行が目安。
- 各まとまりを実行したら何が起きるかを2〜3文で。

【③ 各行(lines)】
- 各行を実行したら実際に何が起きるかを1文で。
- その行でつまずきそうな単語や記号があれば、多くても2〜3個まで、全角カッコで「（〈語〉 … その言葉が実際に何をするか）」と補足する。無ければ補足なし。
- 空行や記号だけの行は空文字でよい。

【④ 主要な単語(words)】
- コード中に出てくる、初心者がつまずきやすい言葉や記号（let, const, async, await, =>, if, for, try, catch, return, fetch など、そのコードに実際にあるもの）について、それぞれ「実際に何をするか」を1文で。

【出力】必ず次のJSONだけを返す。前後に何も付けない。マークダウンも付けない。
{
  "overview": { "guess": "<推測1文>", "action": "<動作1〜2文>" },
  "chunks": [ { "start": <開始行>, "end": <終了行>, "summary": "<2〜3文>" } ],
  "lines": { "<行番号>": "<その行の説明>", ... },
  "words": { "<単語>": "<その単語の説明>", ... }
}
行番号は1から。全ての行が chunks のいずれかに必ず入ること。lines は説明のある行だけでよい。`;

// 予備：単一の行／単語（先読みに無い時のフォールバック）
const SYSTEM_LINE = `コードの1行を実行したら実際に何が起きるかを、やさしい言葉で1文で教えます。${STYLE}
そのあと、その行でつまずきそうな単語を2〜3個まで、全角カッコで「（〈語〉 … 何をするか）」と補足（無ければなし）。前置きなし、説明だけ。`;
const SYSTEM_WORD = `コードの中の1つの言葉や記号が実際に何をするかだけを、やさしい言葉で1文で教えます。${STYLE}
1文だけ。前置きなし、説明だけ。`;

const SYSTEMS = { full: SYSTEM_FULL, line: SYSTEM_LINE, word: SYSTEM_WORD };

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POSTのみ対応' }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'サーバーにAPIキーが設定されていません' }); return; }

  if (overGlobal()) {
    res.status(429).json({ error: '本日の全体のお試し回数が上限に達しました。また明日お試しください。' });
    return;
  }
  const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  if (overLimit(ip)) {
    res.status(429).json({ error: '本日のあなたのお試し回数が上限に達しました。また明日お試しください。' });
    return;
  }

  try {
    const { kind, prompt } = req.body || {};
    const system = SYSTEMS[kind];
    if (!system || !prompt) { res.status(400).json({ error: 'リクエストの形式が正しくありません' }); return; }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        // 先読み(full)は返す量が多いので上限を大きめに。
        max_tokens: kind === 'full' ? 3000 : 300,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: 'AIへの問い合わせに失敗しました', detail: t.slice(0, 200) });
      return;
    }
    const data = await r.json();
    const text = (data.content || []).map(b => b.text || '').join('').trim();
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: 'サーバー内でエラーが発生しました' });
  }
}

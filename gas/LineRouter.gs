/**
 * LINE Webhook 受付窓口(ルーター)
 * ------------------------------------------------------------
 * ■ このファイルの役割
 *   LINEの各チャネルから届くWebhook(doPost)を受け付け、「どのチャネルから来たか」を判定したうえで、
 *   各機能ファイルが登録した受け取り関数(ハンドラ)へイベントを順番に渡すだけの窓口。
 *   機能ごとの処理(天気配信の友だち登録、スケジュール画像の取り込み など)はここには書かない。
 *
 * ■ なぜ窓口を1つにするのか(GAS・LINEの制約)
 *   ・1つのGASプロジェクトに doPost は1つしか置けない(複数ファイルに書くと、どれが動くか不定になる)
 *   ・LINEの1チャネルに設定できるWebhook URLは1つだけ
 *   そのため、LINE関連の機能を足すたびに doPost を書き換えるのではなく、
 *   「窓口はここに1つ、機能は各ファイルが自分で窓口に登録する」形にしている。
 *
 * ■ 新しいLINE機能を追加するときの手順(このファイルは触らない)
 *   新しい .gs ファイルを作り、ファイルの先頭付近に次の2行を書くだけでよい。
 *
 *     var LINE_FEATURE_HANDLERS_ = (typeof LINE_FEATURE_HANDLERS_ !== 'undefined' && LINE_FEATURE_HANDLERS_) || [];
 *     LINE_FEATURE_HANDLERS_.push({ name: '機能名', priority: 50, handle: function (ctx) { return 自分の関数(ctx); } });
 *
 *   ・1行目は必ずこの形で書く(GASはファイルの読み込み順が決まっていないため、どのファイルが先に
 *     読まれても同じ一覧に登録されるようにする書き方)。const / let で宣言し直してはいけない。
 *   ・priority は小さいほど先に呼ばれる。必ず数値で明示する(未指定は警告のうえ最後尾扱い)。
 *     画像など特定の種類だけを扱う機能は小さい値、「それ以外のテキストすべてに案内を返す」ような
 *     受け皿の機能は大きい値にする。
 *   ・現在の登録状況(追加時はここも更新する):
 *       10  家族スケジュール:画像・PDF取り込み(ScheduleIntake_Line.gs) … 4つの個人チャネルの画像・ファイル・動画・音声
 *       100 天気配信:友だち登録(WeatherNotify_Line.gs) … follow と、すべてのテキストメッセージ(受け皿)
 *     テキストを扱う機能を新しく足す場合は、100より小さい値にしないとイベントが届かない。
 *   ・返信は必ず ctx.reply() を使う(1イベント1回の制御を窓口で一元化するため)。
 *   ・handle(ctx) は、そのイベントを自分が処理したら true を返す。true が返った時点で、
 *     後ろの機能には渡さない(LINEの返信(reply)は1イベントにつき1回しかできないため)。
 *     自分の担当でなければ何もせず false を返す。
 *   ・関数名は機能ごとに接頭辞を付ける(全ファイルで名前空間を共有しているため、同名関数は衝突する)。
 *
 * ■ ctx(ハンドラに渡すもの)
 *   ctx.event        … LINEのイベント1件(そのまま)
 *   ctx.channel      … { key: 'YUKI' など, label: 表示名 }
 *   ctx.accessToken  … そのチャネルのアクセストークン(返信・コンテンツ取得に使う)
 *   ctx.props        … スクリプトプロパティ
 *   ctx.reply(text)  … そのイベントへの返信(1回まで。2回目以降は送らずに false を返す)
 *
 * ■ Webhook URLとチャネルの対応
 *   各チャネルのWebhook URLの末尾に ?webhook_token=(スクリプトプロパティ LINE_WEBHOOK_TOKEN_◯◯ と同じ値)
 *   を付けてLINE Developersに登録してある。GASのWebアプリはX-Line-Signatureヘッダーを読めないため、
 *   この値でチャネルの判別と簡易的なアクセス制御を行う(以前 WeatherNotify_Line.gs にあった仕組みを移設)。
 *
 * ■ 注意
 *   ・この窓口では LockService(スクリプトロック)を使わない。スクリプトロックはプロジェクト全体で
 *     1つしかなく、天気配信の2重送信対策が使っているため。
 * ------------------------------------------------------------
 */

var LINE_FEATURE_HANDLERS_ = (typeof LINE_FEATURE_HANDLERS_ !== 'undefined' && LINE_FEATURE_HANDLERS_) || [];

const LINE_ROUTER_REPLY_URL_ = 'https://api.line.me/v2/bot/message/reply';

// ==== Webhookを受け付けるチャネルの一覧(検証用チャネル+配信先ごとの専用チャネル) ====
// (天気配信の checkLineQuota() もこの一覧を使う)
const LINE_CHANNELS_ = [
  { key: 'DEFAULT', label: '崎家エージェント(検証・デバッグ用)', webhookTokenProp: 'LINE_WEBHOOK_TOKEN', accessTokenProp: 'LINE_CHANNEL_ACCESS_TOKEN' },
  { key: 'YUKI', label: '崎家エージェント＠ゆうき用', webhookTokenProp: 'LINE_WEBHOOK_TOKEN_YUKI', accessTokenProp: 'LINE_CHANNEL_ACCESS_TOKEN_YUKI' },
  { key: 'MITSUKI', label: '崎家エージェント＠みつき用', webhookTokenProp: 'LINE_WEBHOOK_TOKEN_MITSUKI', accessTokenProp: 'LINE_CHANNEL_ACCESS_TOKEN_MITSUKI' },
  { key: 'KAZUSHI', label: '崎家エージェント＠一志用', webhookTokenProp: 'LINE_WEBHOOK_TOKEN_KAZUSHI', accessTokenProp: 'LINE_CHANNEL_ACCESS_TOKEN_KAZUSHI' },
  { key: 'KIKUMI', label: '崎家エージェント＠きくみ用', webhookTokenProp: 'LINE_WEBHOOK_TOKEN_KIKUMI', accessTokenProp: 'LINE_CHANNEL_ACCESS_TOKEN_KIKUMI' },
];

// ==== リクエストのwebhook_tokenパラメータから、どのチャネル宛かを判定する ====
// 検証用チャネル(DEFAULT)のみ、LINE_WEBHOOK_TOKEN未設定時は既存の後方互換動作
// (トークン指定なしでも受理する)を維持する。新設の4チャネルは、対応するトークンが
// 設定されていて、かつ一致した場合のみそのチャネルとして扱う。
function resolveLineChannel_(props, givenToken) {
  for (let i = 0; i < LINE_CHANNELS_.length; i++) {
    const channel = LINE_CHANNELS_[i];
    const requiredToken = props.getProperty(channel.webhookTokenProp);
    if (requiredToken && givenToken === requiredToken) return channel;
  }
  const defaultChannel = LINE_CHANNELS_[0];
  if (!props.getProperty(defaultChannel.webhookTokenProp)) return defaultChannel;
  return null;
}

// ==== LINE Webhookのエントリーポイント(プロジェクト内で唯一のdoPost) ====
function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const givenToken = e && e.parameter && e.parameter.webhook_token;
  const channel = resolveLineChannel_(props, givenToken);
  if (!channel) {
    Logger.log('Webhookトークンがどのチャネルとも一致しないため無視しました。');
    return ContentService.createTextOutput('ignored');
  }

  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    Logger.log('Webhookボディの解析に失敗: ' + err.message);
    return ContentService.createTextOutput('ok');
  }

  const accessToken = props.getProperty(channel.accessTokenProp) || '';
  const handlers = getSortedLineFeatureHandlers_();

  (body.events || []).forEach(function (event) {
    const ctx = createLineRouterContext_(event, channel, accessToken, props);
    for (let i = 0; i < handlers.length; i++) {
      const handler = handlers[i];
      let handled = false;
      try {
        handled = handler.handle(ctx) === true;
      } catch (err) {
        // 1つの機能でエラーが出ても、窓口全体・他の機能は止めない
        Logger.log('[' + channel.label + '] 機能「' + handler.name + '」でエラー: ' + err.message);
      }
      if (handled) break;
    }
  });

  return ContentService.createTextOutput('ok');
}

// ==== 登録された機能ハンドラを priority の小さい順に並べて返す ====
// priority は必ず数値で明示すること。未指定の場合は警告ログを出したうえで最後尾(1000)扱いにする。
// 同じ priority どうしは name の順で並べ、ファイルの読み込み順に左右されないようにする。
const LINE_ROUTER_DEFAULT_PRIORITY_ = 1000;

function getSortedLineFeatureHandlers_() {
  function priorityOf(h) {
    if (typeof h.priority === 'number') return h.priority;
    Logger.log('機能「' + h.name + '」の priority が未指定です。最後尾(' + LINE_ROUTER_DEFAULT_PRIORITY_ + ')として扱います。');
    return LINE_ROUTER_DEFAULT_PRIORITY_;
  }
  return LINE_FEATURE_HANDLERS_
    .filter(function (h) { return h && typeof h.handle === 'function'; })
    .map(function (h) { return { handler: h, priority: priorityOf(h), name: String(h.name || '') }; })
    .sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .map(function (x) { return x.handler; });
}

// ==== ハンドラに渡す ctx を作る(返信は1イベント1回までに制限) ====
function createLineRouterContext_(event, channel, accessToken, props) {
  const ctx = {
    event: event,
    channel: { key: channel.key, label: channel.label },
    accessToken: accessToken,
    props: props,
    replied: false,
    reply: function (text) {
      if (ctx.replied || !event.replyToken) return false;
      ctx.replied = true;
      return lineRouterReply_(event.replyToken, text, accessToken);
    },
  };
  return ctx;
}

// ==== replyメッセージを送信(replyは月の無料メッセージ数にカウントされない) ====
function lineRouterReply_(replyToken, text, accessToken) {
  if (!accessToken || !replyToken) return false;
  const response = UrlFetchApp.fetch(LINE_ROUTER_REPLY_URL_, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    Logger.log('LINE返信に失敗(' + response.getResponseCode() + '): ' + response.getContentText());
    return false;
  }
  return true;
}

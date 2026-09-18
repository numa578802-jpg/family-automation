/**
 * LINE Messaging API 送受信ラッパー
 * ------------------------------------------------------------
 * ・push送信: sendLinePushMessage_() … 天気×カレンダー通知の配信に使用
 * ・doPost(e): LINEのWebhookを受信し、「ゆうき」「みつき」「一志」「きくみ」というテキストを送った人の
 *   userIdをスクリプトプロパティに自動登録する(友だち追加後の最初のステップ)。
 *
 * ■ チャネル構成(月200通の無料メッセージ枠がLINEのチャネル単位で管理されるための分割)
 *   同一プロバイダー「崎家エージェント」配下に、配信先ごとの専用チャネルを用意している。
 *     - 崎家エージェント(検証・デバッグ用。既存) … LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET / LINE_WEBHOOK_TOKEN
 *     - 崎家エージェント＠ゆうき用             … LINE_CHANNEL_ACCESS_TOKEN_YUKI     / ..._SECRET_YUKI     / ..._WEBHOOK_TOKEN_YUKI
 *     - 崎家エージェント＠みつき用             … LINE_CHANNEL_ACCESS_TOKEN_MITSUKI  / ..._SECRET_MITSUKI  / ..._WEBHOOK_TOKEN_MITSUKI
 *     - 崎家エージェント＠一志用               … LINE_CHANNEL_ACCESS_TOKEN_KAZUSHI  / ..._SECRET_KAZUSHI  / ..._WEBHOOK_TOKEN_KAZUSHI
 *     - 崎家エージェント＠きくみ用             … LINE_CHANNEL_ACCESS_TOKEN_KIKUMI   / ..._SECRET_KIKUMI   / ..._WEBHOOK_TOKEN_KIKUMI
 *   同一プロバイダー配下であれば、同じ人物のLINE userIdはチャネルが違っても同一の値になるため、
 *   LINE_USER_ID_YUKI等のuserId系プロパティはチャネルをまたいで共通のまま使い回せる。
 *   ゆうきさん向け通知は「ゆうきさん本人→ゆうきチャネル、一志さん(CC)→一志チャネル、
 *   きくみさん(CC)→きくみチャネル」という形で、宛先ごとに送信元チャネルを分けて配信する
 *   (getPersonNotifyRecipients_を参照)。
 *
 * ■ 重要な制約(Google Apps Scriptの仕様)
 *   GASのWebアプリはリクエストの生ヘッダー(X-Line-Signature等)を読み取れないため、
 *   LINE公式の署名検証(HMAC-SHA256)をそのままの形では実装できません。
 *   代わりに、各チャネルのWebhook URLに ?webhook_token=(スクリプトプロパティLINE_WEBHOOK_TOKEN_◯◯と
 *   同じ値)を付与してLINE Developersコンソールに登録することで、どのチャネル宛のリクエストかを判別しつつ、
 *   簡易的なアクセス制御も行います(5チャネル分の登録が必要ですが、Webアプリ自体のデプロイURLは
 *   1つのままで構いません。webhook_tokenの値だけがチャネルごとに異なります)。
 *   (既存プロジェクトのdoGet側でも同様のトークン方式(WEBAPP_TOKEN)が使われているため、
 *   設計を合わせています)
 * ------------------------------------------------------------
 */

const LINE_PUSH_URL_ = 'https://api.line.me/v2/bot/message/push';
const LINE_REPLY_URL_ = 'https://api.line.me/v2/bot/message/reply';

// ==== LINEへpushメッセージを送信(DRY_RUN時は送信せずログのみ) ====
// accessTokenを省略した場合は、検証・デバッグ用チャネル(LINE_CHANNEL_ACCESS_TOKEN)を使う。
function sendLinePushMessage_(userId, text, accessToken) {
  const config = getWeatherConfig_();
  if (!userId) {
    Logger.log('userId未登録のため送信をスキップしました。メッセージ: ' + text);
    return;
  }
  if (config.dryRun) {
    Logger.log('[DRY_RUN] LINE送信をスキップ(実際には送信しません) 宛先: ' + userId + '\n本文:\n' + text);
    return;
  }
  const token = accessToken || config.lineChannelAccessToken;
  if (!token) {
    Logger.log('LINEチャネルアクセストークンが未設定のため送信できません(宛先: ' + userId + ')。');
    return;
  }

  const payload = {
    to: userId,
    messages: [{ type: 'text', text: text }],
  };
  const response = UrlFetchApp.fetch(LINE_PUSH_URL_, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    Logger.log('LINE push送信エラー(' + response.getResponseCode() + '): ' + response.getContentText());
  }
}

// ==== 同一メッセージを複数の宛先へ送信する(本人+CC等)。空欄・重複userIdは自動的にスキップする ====
// recipientsは [{userId, accessToken}, ...] の配列。宛先ごとに異なるチャネル(アクセストークン)を
// 指定できる(getPersonNotifyRecipients_を参照)。
function sendLinePushToRecipients_(recipients, text) {
  const seen = {};
  recipients.forEach(function (recipient) {
    if (!recipient || !recipient.userId || seen[recipient.userId]) return;
    seen[recipient.userId] = true;
    sendLinePushMessage_(recipient.userId, text, recipient.accessToken);
  });
}

// ==== 「ゆうき」「みつき」向け通知の宛先一覧(本人+一志さん・きくみさん)を、
//      それぞれの専用チャネル経由で返す ====
function getPersonNotifyRecipients_(config, personKey) {
  const selfEntry = personKey === 'YUKI'
    ? { userId: config.lineUserIdYuki, accessToken: config.lineChannelAccessTokenYuki }
    : { userId: config.lineUserIdMitsuki, accessToken: config.lineChannelAccessTokenMitsuki };
  return [
    selfEntry,
    { userId: config.lineUserIdKazushi, accessToken: config.lineChannelAccessTokenKazushi },
    { userId: config.lineUserIdKikumi, accessToken: config.lineChannelAccessTokenKikumi },
  ];
}

// ==== LINEへreplyメッセージを送信(Webhookのイベントに対する即時応答) ====
// accessTokenを省略した場合は、検証・デバッグ用チャネル(LINE_CHANNEL_ACCESS_TOKEN)を使う。
function replyLineMessage_(replyToken, text, accessToken) {
  const config = getWeatherConfig_();
  const token = accessToken || config.lineChannelAccessToken;
  if (!token) return;
  const payload = {
    replyToken: replyToken,
    messages: [{ type: 'text', text: text }],
  };
  UrlFetchApp.fetch(LINE_REPLY_URL_, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

// ==== Webhookを受け付けるチャネルの一覧(検証用チャネル+配信先ごとの専用チャネル) ====
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
// 設定されていて、かつ一致した場合のみそのチャネルとして扱う(誤って別チャネル宛の
// リクエストを検証用チャネルとして処理してしまわないようにするため)。
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

// ==== LINE Webhookのエントリーポイント(友だち追加後のuserId自動登録) ====
function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const givenToken = e.parameter && e.parameter.webhook_token;
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

  const channelAccessToken = props.getProperty(channel.accessTokenProp) || '';
  (body.events || []).forEach(function (event) {
    try {
      handleLineWebhookEvent_(event, props, channelAccessToken);
    } catch (err) {
      Logger.log('Webhookイベント処理でエラー(' + channel.label + '): ' + err.message);
    }
  });

  return ContentService.createTextOutput('ok');
}

// ==== Webhookのテキスト登録で使う、キーワード→(スクリプトプロパティ・返信文言)の対応表 ====
const LINE_REGISTRATION_KEYWORDS_ = {
  'ゆうき': { prop: 'LINE_USER_ID_YUKI', replyText: 'ゆうきさんとして登録しました。今後、登校時のバス/自転車提案をお届けします。' },
  'みつき': { prop: 'LINE_USER_ID_MITSUKI', replyText: 'みつきさんとして登録しました。今後、出発時刻のリマインドをお届けします。' },
  '一志': { prop: 'LINE_USER_ID_KAZUSHI', replyText: '一志さんとして登録しました。今後、ゆうきさん・みつきさん向け通知のCCをお届けします。' },
  'きくみ': { prop: 'LINE_USER_ID_KIKUMI', replyText: 'きくみさんとして登録しました。今後、ゆうきさん・みつきさん向け通知のCCをお届けします。' },
};

function handleLineWebhookEvent_(event, props, channelAccessToken) {
  const userId = event.source && event.source.userId;

  if (event.type === 'follow') {
    if (event.replyToken) {
      replyLineMessage_(event.replyToken,
        'お友だち追加ありがとうございます。\n「ゆうき」「みつき」「一志」「きくみ」のいずれかをメッセージで送って、通知の登録をしてください。',
        channelAccessToken);
    }
    return;
  }

  if (event.type === 'message' && event.message && event.message.type === 'text') {
    const text = event.message.text.trim();
    const target = LINE_REGISTRATION_KEYWORDS_[text];
    if (target) {
      props.setProperty(target.prop, userId);
      Logger.log(target.prop + 'を登録しました: ' + userId);
      if (event.replyToken) {
        replyLineMessage_(event.replyToken, target.replyText, channelAccessToken);
      }
    } else if (event.replyToken) {
      replyLineMessage_(event.replyToken, '「ゆうき」「みつき」「一志」「きくみ」のいずれかを送信すると通知の登録ができます。', channelAccessToken);
    }
  }
}

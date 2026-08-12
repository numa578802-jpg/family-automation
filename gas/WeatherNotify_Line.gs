/**
 * LINE Messaging API 送受信ラッパー
 * ------------------------------------------------------------
 * ・push送信: sendLinePushMessage_() … 天気×カレンダー通知の配信に使用
 * ・doPost(e): LINEのWebhookを受信し、「ゆうき」「みつき」というテキストを送った人の
 *   userIdをスクリプトプロパティに自動登録する(友だち追加後の最初のステップ)。
 *
 * ■ 重要な制約(Google Apps Scriptの仕様)
 *   GASのWebアプリはリクエストの生ヘッダー(X-Line-Signature等)を読み取れないため、
 *   LINE公式の署名検証(HMAC-SHA256)をそのままの形では実装できません。
 *   代わりに、Webhook URLに ?webhook_token=(スクリプトプロパティLINE_WEBHOOK_TOKENと同じ値)
 *   を付与してLINE Developersコンソールに登録することで、簡易的なアクセス制御を行います。
 *   (既存プロジェクトのdoGet側でも同様のトークン方式(WEBAPP_TOKEN)が使われているため、
 *   設計を合わせています)
 * ------------------------------------------------------------
 */

const LINE_PUSH_URL_ = 'https://api.line.me/v2/bot/message/push';
const LINE_REPLY_URL_ = 'https://api.line.me/v2/bot/message/reply';

// ==== LINEへpushメッセージを送信(DRY_RUN時は送信せずログのみ) ====
function sendLinePushMessage_(userId, text) {
  const config = getWeatherConfig_();
  if (!userId) {
    Logger.log('userId未登録のため送信をスキップしました。メッセージ: ' + text);
    return;
  }
  if (config.dryRun) {
    Logger.log('[DRY_RUN] LINE送信をスキップ(実際には送信しません) 宛先: ' + userId + '\n本文:\n' + text);
    return;
  }
  if (!config.lineChannelAccessToken) {
    Logger.log('LINE_CHANNEL_ACCESS_TOKEN未設定のため送信できません。');
    return;
  }

  const payload = {
    to: userId,
    messages: [{ type: 'text', text: text }],
  };
  const response = UrlFetchApp.fetch(LINE_PUSH_URL_, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + config.lineChannelAccessToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    Logger.log('LINE push送信エラー(' + response.getResponseCode() + '): ' + response.getContentText());
  }
}

// ==== LINEへreplyメッセージを送信(Webhookのイベントに対する即時応答) ====
function replyLineMessage_(replyToken, text) {
  const config = getWeatherConfig_();
  if (!config.lineChannelAccessToken) return;
  const payload = {
    replyToken: replyToken,
    messages: [{ type: 'text', text: text }],
  };
  UrlFetchApp.fetch(LINE_REPLY_URL_, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + config.lineChannelAccessToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

// ==== LINE Webhookのエントリーポイント(友だち追加後のuserId自動登録) ====
function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const requiredToken = props.getProperty('LINE_WEBHOOK_TOKEN');
  if (requiredToken) {
    const givenToken = e.parameter && e.parameter.webhook_token;
    if (givenToken !== requiredToken) {
      Logger.log('Webhookトークンが一致しないため無視しました。');
      return ContentService.createTextOutput('ignored');
    }
  }

  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    Logger.log('Webhookボディの解析に失敗: ' + err.message);
    return ContentService.createTextOutput('ok');
  }

  (body.events || []).forEach(function (event) {
    try {
      handleLineWebhookEvent_(event, props);
    } catch (err) {
      Logger.log('Webhookイベント処理でエラー: ' + err.message);
    }
  });

  return ContentService.createTextOutput('ok');
}

function handleLineWebhookEvent_(event, props) {
  const userId = event.source && event.source.userId;

  if (event.type === 'follow') {
    if (event.replyToken) {
      replyLineMessage_(event.replyToken,
        'お友だち追加ありがとうございます。\n「ゆうき」または「みつき」とメッセージを送って、通知の登録をしてください。');
    }
    return;
  }

  if (event.type === 'message' && event.message && event.message.type === 'text') {
    const text = event.message.text.trim();
    if (text === 'ゆうき') {
      props.setProperty('LINE_USER_ID_YUKI', userId);
      Logger.log('LINE_USER_ID_YUKIを登録しました: ' + userId);
      if (event.replyToken) {
        replyLineMessage_(event.replyToken, 'ゆうきさんとして登録しました。今後、登校時のバス/自転車提案をお届けします。');
      }
    } else if (text === 'みつき') {
      props.setProperty('LINE_USER_ID_MITSUKI', userId);
      Logger.log('LINE_USER_ID_MITSUKIを登録しました: ' + userId);
      if (event.replyToken) {
        replyLineMessage_(event.replyToken, 'みつきさんとして登録しました。今後、出発時刻のリマインドをお届けします。');
      }
    } else if (event.replyToken) {
      replyLineMessage_(event.replyToken, '「ゆうき」または「みつき」と送信すると通知の登録ができます。');
    }
  }
}

/**
 * 天気×カレンダー配信自動化 - メインエントリ
 * ------------------------------------------------------------
 * ・sendProvisionalNotification() … 前日21時頃に実行(トリガー)。翌日分の暫定版を配信。
 * ・sendFinalNotification()       … 当日6:30頃に実行(トリガー)。当日分の確定版を配信。
 * ・setupWeatherTriggers()        … 上記2つのトリガーを設定する(最初に1回だけ手動実行)。
 *
 * 配信先(LINE userId)は、友だち追加後にWebhook経由で自動登録される
 * (LINE_USER_ID_YUKI / LINE_USER_ID_MITSUKI スクリプトプロパティ)。
 * ------------------------------------------------------------
 */

// ==== トリガー設定(最初に1回だけ手動実行。setupTrigger()とは別名にして既存トリガーと衝突させない) ====
function setupWeatherTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'sendProvisionalNotification' || fn === 'sendFinalNotification') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('sendProvisionalNotification')
    .timeBased()
    .atHour(21)
    .nearMinute(0)
    .everyDays(1)
    .create();

  ScriptApp.newTrigger('sendFinalNotification')
    .timeBased()
    .atHour(6)
    .nearMinute(30)
    .everyDays(1)
    .create();

  Logger.log('天気×カレンダー通知のトリガーを設定しました(前日21:00頃/当日6:30頃)。');
}

// ==== 前日21時頃:翌日分の暫定版を配信 ====
function sendProvisionalNotification() {
  const tomorrow = new Date(new Date().getTime() + 24 * 60 * 60 * 1000);
  runWeatherNotification_(tomorrow, false);
}

// ==== 当日6:30頃:当日分の確定版を配信 ====
function sendFinalNotification() {
  runWeatherNotification_(new Date(), true);
}

// ==== 共通処理:対象日についてゆうきさん・みつきさん双方の通知を判定・送信 ====
function runWeatherNotification_(targetDate, isFinal) {
  const config = getWeatherConfig_();
  const calendarId = getConfig_().calendarId; // 既存の「家族スケジュール自動登録.gs」の設定を再利用
  if (!calendarId) {
    Logger.log('CALENDAR_IDが未設定のため天気×カレンダー通知を中止します。');
    return;
  }
  const dateStr = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');

  // ゆうきさん(バス/自転車提案) → ゆうき本人 + 一志さん・きくみさん(CC、内容確認用)
  try {
    if (isYukiSchoolDay_(targetDate, calendarId)) {
      const result = decideYukiTransport_(targetDate, isFinal);
      const message = buildYukiMessage_(targetDate, result, isFinal);
      sendLinePushToRecipients_([config.lineUserIdYuki, config.lineUserIdKazushi, config.lineUserIdKikumi], message);
    } else {
      Logger.log('ゆうきさん: ' + dateStr + ' は登校日ではないため通知をスキップしました。');
    }
  } catch (e) {
    Logger.log('ゆうきさんの通知処理でエラー: ' + e.message);
  }

  // みつきさん(出発時刻リマインド) → みつき本人 + 一志さん・きくみさん(CC、内容確認用)
  try {
    const result = decideMitsukiReminder_(targetDate, calendarId);
    if (result) {
      const message = buildMitsukiMessage_(targetDate, result, isFinal);
      sendLinePushToRecipients_([config.lineUserIdMitsuki, config.lineUserIdKazushi, config.lineUserIdKikumi], message);
    } else {
      Logger.log('みつきさん: ' + dateStr + ' はリマインド対象の予定が無いため通知をスキップしました。');
    }
  } catch (e) {
    Logger.log('みつきさんの通知処理でエラー: ' + e.message);
  }
}

// ==== 日付ラベル("M/d(月)"形式)の組み立て。GASプロジェクトのロケール設定に依存させず、常に日本語の曜日で出力する ====
const WEEKDAY_LABELS_JA_ = ['日', '月', '火', '水', '木', '金', '土'];
function formatDateLabelJa_(date) {
  const monthDay = Utilities.formatDate(date, 'Asia/Tokyo', 'M/d');
  const dowIndex = Number(Utilities.formatDate(date, 'Asia/Tokyo', 'u')) % 7; // 'u'は月=1〜日=7なので7(日)は%7で0に揃う
  return monthDay + '(' + WEEKDAY_LABELS_JA_[dowIndex] + ')';
}

// ==== ゆうきさん向けメッセージ文面の組み立て ====
function buildYukiMessage_(targetDate, result, isFinal) {
  const dateLabel = formatDateLabelJa_(targetDate);
  const versionLabel = isFinal ? '確定版' : '暫定版';
  const lines = [];
  lines.push('【' + dateLabel + ' 登校 天気予報 - ' + versionLabel + '】');
  lines.push(result.mode + 'を推奨します。');
  if (result.reasons.length > 0) {
    lines.push('理由: ' + result.reasons.join(' / '));
  }
  if (!isFinal) {
    lines.push('※当日6:30頃に確定版をお送りします');
  }
  return lines.join('\n');
}

// ==== みつきさん向けメッセージ文面の組み立て ====
function buildMitsukiMessage_(targetDate, result, isFinal) {
  const dateLabel = formatDateLabelJa_(targetDate);
  const versionLabel = isFinal ? '確定版' : '暫定版';
  const departureLabel = Utilities.formatDate(result.departureTime, 'Asia/Tokyo', 'H:mm');
  const startLabel = Utilities.formatDate(result.startTime, 'Asia/Tokyo', 'H:mm');

  const lines = [];
  lines.push('【' + dateLabel + ' 出発時刻のお知らせ - ' + versionLabel + '】');
  lines.push('予定: ' + result.label + '(' + startLabel + '〜)');
  lines.push('家を出る目安: ' + departureLabel + '頃');
  const detailParts = ['自転車で約' + result.travelMinutes + '分'];
  if (result.isRaining) {
    detailParts.push('雨天バッファ+' + result.bufferMin + '分');
  }
  lines.push('(' + detailParts.join(' + ') + ')');
  if (result.pop !== null) {
    lines.push('降水確率: ' + result.pop + '%');
  }
  if (!isFinal) {
    lines.push('※当日6:30頃に確定版をお送りします');
  }
  return lines.join('\n');
}

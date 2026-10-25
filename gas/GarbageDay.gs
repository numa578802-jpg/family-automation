/**
 * ごみの日:家族カレンダーへの登録 + 当日朝のLINE通知(一志・きくみ宛)
 * ------------------------------------------------------------
 * 月1回だけある「金属ごみ(毎月 第1水曜日)」「埋めるごみ(毎月 第3水曜日)」を扱う。
 * 出す場所はどちらも「分別ごみステーション」。
 *
 * ■ やること
 *   1. 家族カレンダー(スクリプトプロパティ CALENDAR_ID)に、終日予定「【ゴミ】金属ごみ」「【ゴミ】埋めるごみ」を
 *      12か月先まで登録する(registerGarbageDayEvents)。同じ日に同じタイトルがあれば作らない(何度実行しても安全)。
 *      毎月1日の朝の通知処理のついでに、12か月先まで自動で足す(足し忘れ防止)。
 *   2. 該当日の朝に、一志さん(一志用チャネル)ときくみさん(きくみ用チャネル)へLINEで知らせる
 *      (sendGarbageDayNotification。毎朝トリガーで実行し、該当日以外は何もしない)。
 *
 * ■ 設計上の注意(他の機能との関係)
 *   ・予定のタイトルは「【ゴミ】」で始める。天気配信は【ゆうき】【みつき】で始まる予定だけを見るため、
 *     この予定が登校日判定・出発時刻のお知らせ等に影響することはない。
 *   ・日付の判定はカレンダーではなく計算(第N水曜日)で行う。カレンダーの予定を消しても通知は届く。
 *   ・LINE送信はこのファイル内で行う(天気配信側の sendLinePushMessage_ は、全通知に河川水位リンクを
 *     付ける仕様のため使わない)。送信元チャネル・userId・DRY_RUN(WEATHER_DRY_RUN)は天気配信と同じ
 *     スクリプトプロパティを読むだけで、天気配信側のファイルは変更しない。
 *   ・LockService(スクリプトロック)は使わない。
 *   ・追加するトリガーは sendGarbageDayNotification の1つだけ。setupGarbageDayTriggers() は、この関数名の
 *     トリガーだけを作り直す(他のトリガーは削除しない)。
 *   ・LINEの月200通の枠への影響: 一志用・きくみ用チャネルとも、1か月あたり2通(第1・第3水曜日)。
 *
 * ■ 設定の変え方
 *   GARBAGE_SCHEDULES_ に1行足すと、ごみの種類を増やせる(week: 第何回目、weekday: 0=日〜6=土)。
 *
 * ■ 最初にやること(GASエディタから手動で1回ずつ)
 *   1. previewGarbageDayMessages() … 今後の日付と通知文をログで確認(登録も送信もしない)
 *   2. registerGarbageDayEvents()  … カレンダーに12か月分を登録
 *   3. setupGarbageDayTriggers()   … 毎朝の通知トリガーを設定
 * ------------------------------------------------------------
 */

const GARBAGE_SCHEDULES_ = [
  { key: 'metal', label: '金属ごみ', week: 1, weekday: 3, place: '分別ごみステーション', rule: '毎月 第1水曜日' },
  { key: 'landfill', label: '埋めるごみ', week: 3, weekday: 3, place: '分別ごみステーション', rule: '毎月 第3水曜日' },
];

const GARBAGE_TITLE_PREFIX_ = '【ゴミ】';
const GARBAGE_EVENT_MONTHS_AHEAD_ = 12;
const GARBAGE_NOTIFY_HOUR_ = 6;
const GARBAGE_NOTIFY_NEAR_MINUTE_ = 50; // 天気配信の確定版(6:30頃)とずらす。実際の実行は前後15分ほどぶれる
const GARBAGE_LAST_NOTIFIED_PROP_ = 'GARBAGE_DAY_LAST_NOTIFIED';
const GARBAGE_WEEKDAY_LABELS_ = ['日', '月', '火', '水', '木', '金', '土'];

// ==== その日(年月日)に該当するごみの種類を返す。date は Date(スクリプトのタイムゾーン=日本時間で解釈) ====
function garbageDayTypesFor_(date) {
  const weekday = date.getDay();
  const nth = Math.floor((date.getDate() - 1) / 7) + 1; // その月の第何回目の曜日か
  return GARBAGE_SCHEDULES_.filter(function (s) {
    return s.weekday === weekday && s.week === nth;
  });
}

// ==== 指定した年・月(month は 0〜11)の、各ごみの日の Date を日付順に返す ====
function garbageDaysInMonth_(year, month) {
  const result = [];
  const lastDate = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= lastDate; d++) {
    const date = new Date(year, month, d);
    garbageDayTypesFor_(date).forEach(function (type) {
      result.push({ date: date, type: type });
    });
  }
  return result;
}

function garbageDateKey_(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function garbageDateLabel_(date) {
  return (date.getMonth() + 1) + '月' + date.getDate() + '日(' + GARBAGE_WEEKDAY_LABELS_[date.getDay()] + ')';
}

// ==== 通知文 ====
function buildGarbageDayMessage_(types) {
  const names = types.map(function (t) { return t.label; }).join('・');
  const places = types.map(function (t) { return t.place; }).filter(function (p, i, arr) { return arr.indexOf(p) === i; });
  return '【ゴミの日】今日は' + names + 'の日です。\n出す場所: ' + places.join('・');
}

// ==== 12か月先までのカレンダー予定を登録(重複はスキップ)。戻り値: 新しく作った件数 ====
function ensureGarbageDayEvents_(fromDate, monthsAhead) {
  const calendarId = getConfig_().calendarId; // 家族スケジュール自動登録.gs の設定を再利用
  if (!calendarId) throw new Error('スクリプトプロパティ CALENDAR_ID が未設定です');
  const calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) throw new Error('カレンダーが見つかりません。CALENDAR_IDを確認してください。');

  const today = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  let created = 0;
  for (let i = 0; i <= monthsAhead; i++) {
    const monthStart = new Date(today.getFullYear(), today.getMonth() + i, 1);
    garbageDaysInMonth_(monthStart.getFullYear(), monthStart.getMonth()).forEach(function (item) {
      if (item.date.getTime() < today.getTime()) return; // 過去日は作らない
      const title = GARBAGE_TITLE_PREFIX_ + item.type.label;
      const dayEnd = new Date(item.date.getFullYear(), item.date.getMonth(), item.date.getDate() + 1);
      const exists = calendar.getEvents(item.date, dayEnd).some(function (e) { return e.getTitle() === title; });
      if (exists) return;
      calendar.createAllDayEvent(title, item.date, {
        location: item.type.place,
        description: item.type.rule + ' / ' + item.type.place + ' [自動登録: ごみの日]',
      });
      created++;
      Utilities.sleep(300); // レート制限回避
    });
  }
  return created;
}

// ==== 手動実行: カレンダーに12か月分を登録 ====
function registerGarbageDayEvents() {
  const created = ensureGarbageDayEvents_(new Date(), GARBAGE_EVENT_MONTHS_AHEAD_);
  Logger.log('ごみの日の予定を ' + created + ' 件登録しました(既にある分はスキップ)。');
}

// ==== 手動実行: 今後の日付と通知文を確認(登録も送信もしない) ====
function previewGarbageDayMessages() {
  const today = new Date();
  for (let i = 0; i < 4; i++) {
    const monthStart = new Date(today.getFullYear(), today.getMonth() + i, 1);
    garbageDaysInMonth_(monthStart.getFullYear(), monthStart.getMonth()).forEach(function (item) {
      Logger.log(garbageDateLabel_(item.date) + ' → ' + item.type.label + '\n' + buildGarbageDayMessage_([item.type]));
    });
  }
  const config = getWeatherConfig_();
  Logger.log('送信モード: ' + (config.dryRun ? 'DRY_RUN(実際には送信されない)' : '本番(実際に送信される)') +
    ' / 一志userId登録: ' + (config.lineUserIdKazushi ? 'あり' : 'なし') +
    ' / きくみuserId登録: ' + (config.lineUserIdKikumi ? 'あり' : 'なし'));
}

// ==== 毎朝のトリガーから呼ばれる: 今日がごみの日なら一志・きくみに送る ====
function sendGarbageDayNotification() {
  const today = new Date();

  // 毎月1日は、12か月先までの予定を足しておく(失敗しても通知は続ける)
  if (today.getDate() === 1) {
    try {
      const created = ensureGarbageDayEvents_(today, GARBAGE_EVENT_MONTHS_AHEAD_);
      Logger.log('ごみの日の予定を ' + created + ' 件追加しました。');
    } catch (e) {
      Logger.log('ごみの日の予定の追加に失敗: ' + e.message);
    }
  }

  const types = garbageDayTypesFor_(today);
  if (types.length === 0) return; // 該当日でなければ何もしない

  const props = PropertiesService.getScriptProperties();
  const doneKey = garbageDateKey_(today);
  if (props.getProperty(GARBAGE_LAST_NOTIFIED_PROP_) === doneKey) {
    Logger.log('本日(' + doneKey + ')のごみの日の通知は送信済みのためスキップしました。');
    return;
  }

  const message = buildGarbageDayMessage_(types);
  const config = getWeatherConfig_();
  const recipients = [
    { userId: config.lineUserIdKazushi, accessToken: config.lineChannelAccessTokenKazushi, channelLabel: '一志用' },
    { userId: config.lineUserIdKikumi, accessToken: config.lineChannelAccessTokenKikumi, channelLabel: 'きくみ用' },
  ];

  let okCount = 0;
  recipients.forEach(function (r) {
    if (garbageDayPush_(r, message, config.dryRun)) okCount++;
  });

  if (okCount === 0) {
    // 1人にも送れなかった場合は、失敗として記録(GASのエラーメールで気づけるようにする)。送信済みの印は付けない
    throw new Error('ごみの日の通知を誰にも送れませんでした(' + doneKey + ')。ログを確認してください。');
  }
  props.setProperty(GARBAGE_LAST_NOTIFIED_PROP_, doneKey);
}

// ==== 1人分のLINE送信。送れた(またはDRY_RUN)なら true ====
function garbageDayPush_(recipient, text, dryRun) {
  const prefix = '[' + recipient.channelLabel + '] ';
  if (!recipient.userId) {
    Logger.log(prefix + 'userId未登録のため送信をスキップしました。');
    return false;
  }
  if (dryRun) {
    Logger.log(prefix + '[DRY_RUN] LINE送信をスキップ(実際には送信しません)\n本文:\n' + text);
    return true;
  }
  if (!recipient.accessToken) {
    Logger.log(prefix + 'チャネルアクセストークンが未設定のため送信できません。');
    return false;
  }
  try {
    const response = UrlFetchApp.fetch(LINE_PUSH_URL_, { // LINE_PUSH_URL_ は WeatherNotify_Line.gs の定数
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + recipient.accessToken },
      payload: JSON.stringify({ to: recipient.userId, messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true,
    });
    if (response.getResponseCode() === 200) {
      Logger.log(prefix + '送信成功(200)');
      return true;
    }
    Logger.log(prefix + '送信失敗(' + response.getResponseCode() + '): ' + response.getContentText());
    return false;
  } catch (e) {
    Logger.log(prefix + '送信中にエラー: ' + e.message);
    return false;
  }
}

// ==== 手動実行: 毎朝のトリガーを設定(この機能のトリガーだけを作り直す) ====
function setupGarbageDayTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendGarbageDayNotification') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendGarbageDayNotification')
    .timeBased()
    .atHour(GARBAGE_NOTIFY_HOUR_)
    .nearMinute(GARBAGE_NOTIFY_NEAR_MINUTE_)
    .everyDays(1)
    .create();
  Logger.log('ごみの日の通知トリガーを設定しました(毎朝' + GARBAGE_NOTIFY_HOUR_ + ':' + GARBAGE_NOTIFY_NEAR_MINUTE_ + '頃)。');
}

/**
 * 予定エクスポート(スタンドアロン版・項目A6)
 * ------------------------------------------------------------
 * 他のプロジェクトのファイル・関数に一切依存しない、単体で動作するエクスポート関数。
 * CALENDAR_IDはgetConfig_()を経由せず、スクリプトプロパティから直接読む。
 * 出力対象: 予定名が【氏名】タグで始まる予定のみ(タイトル・開始/終了時刻・終日フラグ)。
 * 実行後、Apps Scriptエディタの「実行数」または「実行ログ」からJSON出力を確認できる。
 * ------------------------------------------------------------
 */
function exportTaggedScheduleStandalone() {
  const calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  if (!calendarId) {
    Logger.log('CALENDAR_IDが未設定です。');
    return;
  }

  // 対象期間: 実行日から前後30日間(必要に応じてこの2つの値を書き換えてください)
  const DAYS_BEFORE = 30;
  const DAYS_AFTER = 30;
  const now = new Date();
  const rangeStart = new Date(now.getTime() - DAYS_BEFORE * 24 * 60 * 60 * 1000);
  const rangeEnd = new Date(now.getTime() + DAYS_AFTER * 24 * 60 * 60 * 1000);

  const calendar = CalendarApp.getCalendarById(calendarId);
  const events = calendar.getEvents(rangeStart, rangeEnd);

  const TAG_PATTERN = /^【[^】]+】/; // 予定名が【氏名】タグで始まるものだけを対象にする

  const result = events
    .filter(function (ev) { return TAG_PATTERN.test(ev.getTitle()); })
    .map(function (ev) {
      return {
        title: ev.getTitle(),
        startTime: ev.getStartTime().toISOString(),
        endTime: ev.getEndTime().toISOString(),
        isAllDay: ev.isAllDayEvent(),
      };
    });

  Logger.log(JSON.stringify(result, null, 2));
}

/**
 * 予定エクスポート(スタンドアロン版・短縮形式)
 * ------------------------------------------------------------
 * exportTaggedScheduleStandalone()の整形済みJSON出力は文字数が多く、チャット等への
 * 貼り付け時に途中で切れやすいため、1行=1件・配列形式の短い出力にしたもの。
 * 出力形式(実行ログの1行=1件): ["タイトル","開始(JST)","終了(JST)",終日フラグ(0/1)]
 *   ・時刻付き予定: 開始・終了とも "yyyy-MM-ddTHH:mm"(JST、秒以下は省略)。
 *   ・終日予定: 開始・終了とも "yyyy-MM-dd"(日付のみ)。終了日はカレンダーの仕様どおり
 *     「その翌日」(排他的)のまま出力する(例: 9/11の1日だけの終日予定は
 *     ["...","2026-09-11","2026-09-12",1])。
 * 対象期間: 実行日から31日間(今日を含む。DAYS_AFTERを書き換えれば調整可能)。
 * 出力対象: 予定名が【氏名】タグで始まる予定のみ。
 * 最後に「END count=件数」の行を出す(ログが途中で切れていないことを確認する印)。
 * ------------------------------------------------------------
 */
function exportTaggedScheduleCompact() {
  const calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  if (!calendarId) {
    Logger.log('CALENDAR_IDが未設定です。');
    return;
  }

  // 対象期間: 実行日から31日間(必要に応じてこの値を書き換えてください)
  const DAYS_AFTER = 31;
  const now = new Date();
  const rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rangeEnd = new Date(rangeStart.getTime() + DAYS_AFTER * 24 * 60 * 60 * 1000);

  const calendar = CalendarApp.getCalendarById(calendarId);
  const events = calendar.getEvents(rangeStart, rangeEnd);

  const TAG_PATTERN = /^【[^】]+】/; // 予定名が【氏名】タグで始まるものだけを対象にする
  const pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
  const formatDate = function (d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  const formatDateTime = function (d) { return formatDate(d) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };

  let count = 0;
  events
    .filter(function (ev) { return TAG_PATTERN.test(ev.getTitle()); })
    .forEach(function (ev) {
      const isAllDay = ev.isAllDayEvent();
      const startStr = isAllDay ? formatDate(ev.getStartTime()) : formatDateTime(ev.getStartTime());
      const endStr = isAllDay ? formatDate(ev.getEndTime()) : formatDateTime(ev.getEndTime());
      Logger.log(JSON.stringify([ev.getTitle(), startStr, endStr, isAllDay ? 1 : 0]));
      count++;
    });

  Logger.log('END count=' + count);
}

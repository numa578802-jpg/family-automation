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

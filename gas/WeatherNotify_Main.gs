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

  // 危険警報チェック(確定版のみ。現状はmatchesDangerWarning_が未実装のため常にnullを返す暫定実装)
  let dangerWarningLine = null;
  if (isFinal) {
    try {
      dangerWarningLine = buildDangerWarningLine_(checkDangerWarnings_());
    } catch (e) {
      Logger.log('危険警報チェックの呼び出しでエラー(通知全体は続行します): ' + e.message);
    }
  }

  // ゆうきさん(バス/自転車提案。朝・帰り往復で判定) → ゆうき本人 + 一志さん・きくみさん(CC、内容確認用)
  try {
    if (isYukiSchoolDay_(targetDate, calendarId)) {
      const result = decideYukiTransport_(targetDate, isFinal, calendarId);
      let message = buildYukiMessage_(targetDate, result, isFinal);
      if (dangerWarningLine) message = dangerWarningLine + '\n\n' + message;
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
      let message = buildMitsukiMessage_(targetDate, result, isFinal);
      if (dangerWarningLine) message = dangerWarningLine + '\n\n' + message;
      sendLinePushToRecipients_([config.lineUserIdMitsuki, config.lineUserIdKazushi, config.lineUserIdKikumi], message);
    } else {
      Logger.log('みつきさん: ' + dateStr + ' はリマインド対象の予定が無いため通知をスキップしました。');
    }
  } catch (e) {
    Logger.log('みつきさんの通知処理でエラー: ' + e.message);
  }

  // みつきさん(部活/お茶の日の送迎提案・新規) → みつき本人 + 一志さん・きくみさん(CC、内容確認用)
  try {
    const escortResult = decideMitsukiEscort_(targetDate, calendarId);
    if (escortResult) {
      const escortMessage = buildMitsukiEscortMessage_(targetDate, escortResult, isFinal);
      sendLinePushToRecipients_([config.lineUserIdMitsuki, config.lineUserIdKazushi, config.lineUserIdKikumi], escortMessage);
    } else {
      Logger.log('みつきさん: ' + dateStr + ' は部活動/お茶の予定が無いため送迎提案をスキップしました。');
    }
  } catch (e) {
    Logger.log('みつきさんの送迎提案処理でエラー: ' + e.message);
  }

  // 確定版配信時のみ、下校時刻の少し前に「下校時 雨雲通過予報」を予約する(新規)
  if (isFinal) {
    try {
      scheduleHomewardRainAlerts_(targetDate, calendarId);
    } catch (e) {
      Logger.log('下校時雨雲アラートの予約処理でエラー: ' + e.message);
    }
  }
}

// ==== 日付ラベル("M/d(月)"形式)の組み立て。GASプロジェクトのロケール設定に依存させず、常に日本語の曜日で出力する ====
const WEEKDAY_LABELS_JA_ = ['日', '月', '火', '水', '木', '金', '土'];
function formatDateLabelJa_(date) {
  const monthDay = Utilities.formatDate(date, 'Asia/Tokyo', 'M/d');
  const dowIndex = Number(Utilities.formatDate(date, 'Asia/Tokyo', 'u')) % 7; // 'u'は月=1〜日=7なので7(日)は%7で0に揃う
  return monthDay + '(' + WEEKDAY_LABELS_JA_[dowIndex] + ')';
}

// ==== 天気情報の出典リンク行を組み立てる(使ったデータ種別が無ければnull) ====
function buildSourceLinksLine_(usedPop, usedNowcast) {
  const urls = [];
  if (usedPop) urls.push(WEATHER_SOURCE_URL_POP_);
  if (usedNowcast) urls.push(WEATHER_SOURCE_URL_NOWCAST_);
  if (urls.length === 0) return null;
  return '詳細: ' + urls.join(' ');
}

// ==== ゆうきさん向けメッセージ文面の組み立て(朝・帰り往復の判定を反映) ====
function buildYukiMessage_(targetDate, result, isFinal) {
  const dateLabel = formatDateLabelJa_(targetDate);
  const versionLabel = isFinal ? '確定版' : '暫定版';
  const lines = [];
  lines.push('【' + dateLabel + ' 登校 天気予報 - ' + versionLabel + '】');

  const morningRainy = result.morning.rainy;
  const afternoonRainy = result.afternoon.rainy;
  const homewardLabel = result.homewardTime ? Utilities.formatDate(result.homewardTime, 'Asia/Tokyo', 'H:mm') : '';

  if (morningRainy) {
    lines.push('バスを推奨します。');
  } else if (afternoonRainy) {
    lines.push('朝は良好ですが、下校時間帯(' + homewardLabel + '頃)の天候により、' +
      '自転車ではなくバスでの往復を推奨します。');
  } else {
    lines.push('自転車を推奨します。');
  }

  lines.push('理由(朝): ' + result.morning.reasons.join(' / '));
  if (result.afternoon.reasons.length > 0) {
    lines.push('理由(帰り' + (homewardLabel ? '・' + homewardLabel + '頃' : '') + '): ' + result.afternoon.reasons.join(' / '));
  }

  const usedPop = result.morning.usedPop || result.afternoon.usedPop;
  const usedNowcast = result.morning.usedNowcast || result.afternoon.usedNowcast;
  const sourceLine = buildSourceLinksLine_(usedPop, usedNowcast);
  if (sourceLine) lines.push(sourceLine);

  if (!isFinal) {
    lines.push('※当日6:30頃に確定版をお送りします');
  }
  return lines.join('\n');
}

// ==== みつきさん向けメッセージ文面の組み立て(出発時刻のお知らせ) ====
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
  const sourceLine = buildSourceLinksLine_(result.usedPop, false);
  if (sourceLine) lines.push(sourceLine);
  if (!isFinal) {
    lines.push('※当日6:30頃に確定版をお送りします');
  }
  return lines.join('\n');
}

// ==== みつきさん向けメッセージ文面の組み立て(部活動/お茶の日の送迎提案・新規) ====
function buildMitsukiEscortMessage_(targetDate, result, isFinal) {
  const dateLabel = formatDateLabelJa_(targetDate);
  const versionLabel = isFinal ? '確定版' : '暫定版';
  const goLabel = Utilities.formatDate(result.goTime, 'Asia/Tokyo', 'H:mm');
  const returnLabel = Utilities.formatDate(result.returnTime, 'Asia/Tokyo', 'H:mm');

  const lines = [];
  lines.push('【' + dateLabel + ' ' + result.label + ' 送迎提案 - ' + versionLabel + '】');
  if (result.mode === '送迎') {
    lines.push('送迎(祖父母または父)を検討してください。');
  } else {
    lines.push('徒歩で問題なさそうです。');
  }
  lines.push('理由(行き・' + goLabel + '頃): ' + result.go.reasons.join(' / '));
  lines.push('理由(帰り・' + returnLabel + '頃): ' + result.ret.reasons.join(' / '));

  const usedPop = result.go.usedPop || result.ret.usedPop;
  const usedNowcast = result.go.usedNowcast || result.ret.usedNowcast;
  const sourceLine = buildSourceLinksLine_(usedPop, usedNowcast);
  if (sourceLine) lines.push(sourceLine);

  if (!isFinal) {
    lines.push('※当日6:30頃に確定版をお送りします');
  }
  return lines.join('\n');
}

/**
 * 下校時アラート(項目3・新規)
 * ------------------------------------------------------------
 * 確定版配信時(sendFinalNotification)に、ゆうき・みつきそれぞれの下校予定時刻(getHomewardDepartureTime_)の
 * HOMEWARD_ALERT_LEAD_MIN分前(デフォルト30分)に発火する使い捨てトリガーを予約する。
 * 既存の「家族スケジュール自動登録.gs」のscheduleNotification_/runScheduledNotifications_と同じ、
 * スクリプトプロパティ+使い捨てトリガーによる予約パターンを踏襲している。
 * ------------------------------------------------------------
 */
const HOMEWARD_ALERT_PENDING_PREFIX_ = 'PENDING_HOMEWARD_ALERT_';

// ==== 確定版配信時に、ゆうき・みつき双方の下校時雨雲アラートを予約する ====
function scheduleHomewardRainAlerts_(targetDate, calendarId) {
  const config = getWeatherConfig_();
  const leadMin = config.homewardAlertLeadMin;

  scheduleHomewardRainAlertFor_('YUKI', 'ゆうき', targetDate, calendarId, '【ゆうき】',
    getYukiDefaultSchoolEnd_(), YUKI_ROUTE_CHECK_KEYS_, config.lineUserIdYuki, leadMin);
  scheduleHomewardRainAlertFor_('MITSUKI', 'みつき', targetDate, calendarId, '【みつき】',
    getMitsukiDefaultSchoolEnd_(), ['HOME', 'SCHOOL_MITSUKI'], config.lineUserIdMitsuki, leadMin);
}

function scheduleHomewardRainAlertFor_(personKey, personLabel, targetDate, calendarId, namePrefix, defaultEndTime, routeKeys, selfUserId, leadMin) {
  const homeward = getHomewardDepartureTime_(targetDate, calendarId, namePrefix, defaultEndTime);
  if (!homeward) {
    Logger.log(personLabel + ': 下校予定が無いため、下校時雨雲アラートは予約しませんでした。');
    return;
  }
  const alertTime = new Date(homeward.time.getTime() - leadMin * 60 * 1000);
  if (alertTime.getTime() <= Date.now()) {
    Logger.log(personLabel + ': 下校時刻(' + homeward.time + ')が近すぎる/過去のため、下校時雨雲アラートは予約しませんでした。');
    return;
  }

  const props = PropertiesService.getScriptProperties();
  const key = HOMEWARD_ALERT_PENDING_PREFIX_ + personKey + '_' + Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyyMMdd');
  props.setProperty(key, JSON.stringify({
    personLabel: personLabel,
    routeKeys: routeKeys,
    selfUserId: selfUserId,
    scheduledAt: alertTime.toISOString(),
    homewardTime: homeward.time.toISOString(),
  }));
  ScriptApp.newTrigger('runScheduledHomewardAlerts_').timeBased().at(alertTime).create();
  Logger.log(personLabel + ': 下校時雨雲アラートを' + alertTime + 'に予約しました(下校予定 ' + homeward.time + ')。');
}

// ==== 予約された下校時雨雲アラートを、実際の時刻が来たら送信する(使い捨てトリガーから呼ばれる) ====
function runScheduledHomewardAlerts_(e) {
  // 自分自身を呼び出したトリガーは、多重実行を防ぐため実行後すぐ削除する
  if (e && e.triggerUid) {
    ScriptApp.getProjectTriggers().forEach(function (trigger) {
      if (trigger.getUniqueId() === e.triggerUid) {
        ScriptApp.deleteTrigger(trigger);
      }
    });
  }

  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();
  const now = Date.now();
  const config = getWeatherConfig_();

  Object.keys(allProps).forEach(function (key) {
    if (key.indexOf(HOMEWARD_ALERT_PENDING_PREFIX_) !== 0) return;
    const data = JSON.parse(allProps[key]);
    // まだこのアラートの予定時刻に達していなければ、他の人のトリガーからの呼び出しとみなしスキップする
    if (new Date(data.scheduledAt).getTime() > now + 60 * 1000) return;

    props.deleteProperty(key); // 二重送信防止のため、処理対象として取り出した時点で先に削除

    try {
      const rainSpotDetails = [];
      data.routeKeys.forEach(function (locKey) {
        const mmh = getMaxForecastRainfallMmh_(locKey);
        if (mmh !== null) rainSpotDetails.push({ label: WEATHER_LOCATIONS_[locKey].label, mmh: mmh });
      });
      const message = buildHomewardRainAlertMessage_(data.personLabel, new Date(data.homewardTime), rainSpotDetails);
      sendLinePushToRecipients_([data.selfUserId, config.lineUserIdKazushi, config.lineUserIdKikumi], message);
    } catch (err) {
      Logger.log('下校時雨雲アラートの送信でエラー(' + data.personLabel + '): ' + err.message);
    }
  });
}

// ==== 下校時雨雲通過予報のメッセージ文面(交通手段の提案は含めない、実測・予測値のみ) ====
function buildHomewardRainAlertMessage_(personLabel, homewardTime, rainSpotDetails) {
  const timeLabel = Utilities.formatDate(homewardTime, 'Asia/Tokyo', 'H:mm');
  const lines = [];
  lines.push('【' + personLabel + ' 下校時 雨雲通過予報】');
  lines.push('下校予定(' + timeLabel + '頃)にかけての雨雲の様子:');
  if (rainSpotDetails.length === 0) {
    lines.push('雨雲情報を取得できませんでした。');
  } else {
    rainSpotDetails.forEach(function (spot) {
      lines.push('・' + spot.label + ': ' + spot.mmh + 'mm/h');
    });
  }
  const sourceLine = buildSourceLinksLine_(false, rainSpotDetails.length > 0);
  if (sourceLine) lines.push(sourceLine);
  return lines.join('\n');
}

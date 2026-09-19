/**
 * 天気×カレンダー配信自動化 - メインエントリ
 * ------------------------------------------------------------
 * ・sendProvisionalNotification() … 前日21時頃に実行(トリガー)。翌日分の暫定版を配信。
 * ・sendFinalNotification()       … 当日6:30頃に実行(トリガー)。当日分の確定版を配信。
 * ・setupWeatherTriggers()        … 上記2つのトリガーを設定する(最初に1回だけ手動実行)。
 *
 * 配信先(LINE userId)は、友だち追加後にWebhook経由で自動登録される
 * (LINE_USER_ID_YUKI / LINE_USER_ID_MITSUKI スクリプトプロパティ)。
 *
 * ■ 通知の種類(2026年9月改訂: 送迎提案・出発時刻のお知らせ・リマインドを「出発まわりの通知」に統合)
 *   1. 登校 天気予報(ゆうき、登校日のみ) … 既存のバス/自転車判定(decideYukiTransport_)
 *   2. 登校 出発時刻のお知らせ(みつき、登校日のみ) … 自転車通学の出発目安。送迎提案は出さない
 *   3. 出発まわりの通知(ゆうき・みつき共通) … 非登校日の時刻付き予定すべて、登校日は英語・お茶等
 *      「家から向かう習い事」のみが対象。天気・移動手段・出発時刻・車送迎要否をまとめて1通で案内する。
 *      暫定版は必ず送るが、確定版は暫定版から判断が変わった場合のみ送る。
 *   4. 帰りの雨雲通過予報(ゆうき・みつき共通) … 帰り予定時刻の少し前に発火する使い捨てトリガー
 *   5. 車送迎の直前アラート(出発まわりの通知でCARモードの予定のみ) … 出発の少し前に発火する使い捨てトリガー
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

  // 朝の登校提案メッセージに付ける安全情報。
  // 危険警報は本文より優先度が高いため冒頭に配置(確定版のみ判定。現状はmatchesDangerWarning_が
  // 未実装のため常にnullを返す暫定実装)。河川水位情報リンクは本文の末尾に追記する(常時固定表示。自動取得はしない)。
  let dangerWarningPrefix = '';
  if (isFinal) {
    try {
      const warningLine = buildDangerWarningLine_(checkDangerWarnings_());
      if (warningLine) dangerWarningPrefix = warningLine + '\n\n';
    } catch (e) {
      Logger.log('危険警報チェックの呼び出しでエラー(通知全体は続行します): ' + e.message);
    }
  }
  const riverLine = buildRiverLevelInfoLine_();
  const riverSuffix = riverLine ? '\n\n' + riverLine : '';

  // ゆうきさん(バス/自転車提案。朝・帰り往復で判定) → ゆうき本人 + 一志さん・きくみさん(CC、内容確認用)
  try {
    if (isYukiSchoolDay_(targetDate, calendarId)) {
      const result = decideYukiTransport_(targetDate, isFinal, calendarId);
      const message = dangerWarningPrefix + buildYukiMessage_(targetDate, result, isFinal) + riverSuffix;
      sendLinePushToRecipients_(getPersonNotifyRecipients_(config, 'YUKI'), message);
    } else {
      Logger.log('ゆうきさん: ' + dateStr + ' は登校日ではないため登校 天気予報をスキップしました。');
    }
  } catch (e) {
    Logger.log('ゆうきさんの登校 天気予報処理でエラー: ' + e.message);
  }

  // みつきさん(登校・自転車通学の出発時刻お知らせ。送迎提案は出さない) → みつき本人 + 一志さん・きくみさん(CC)
  try {
    const commuteResult = decideMitsukiSchoolCommute_(targetDate, calendarId);
    if (commuteResult) {
      const message = dangerWarningPrefix + buildMitsukiSchoolCommuteMessage_(targetDate, commuteResult, isFinal) + riverSuffix;
      sendLinePushToRecipients_(getPersonNotifyRecipients_(config, 'MITSUKI'), message);
    } else {
      Logger.log('みつきさん: ' + dateStr + ' は登校日ではないため登校 出発時刻のお知らせをスキップしました。');
    }
  } catch (e) {
    Logger.log('みつきさんの登校 出発時刻のお知らせ処理でエラー: ' + e.message);
  }

  // 出発まわりの通知(ゆうき・みつき共通。項目A) → 本人 + 一志さん・きくみさん(CC)
  // 暫定版は必ず送り、確定版は暫定版時点から判断が変わった予定のみ送る(diffDepartureNotice_)。
  const departureNoticesByPerson = {};
  [
    { key: 'YUKI', label: 'ゆうき', compute: function () { return decideYukiDepartureNotices_(targetDate, calendarId); } },
    { key: 'MITSUKI', label: 'みつき', compute: function () { return decideMitsukiDepartureNotices_(targetDate, calendarId); } },
  ].forEach(function (person) {
    let results = [];
    try {
      results = person.compute();
    } catch (e) {
      Logger.log(person.label + 'の出発まわりの通知の算出でエラー: ' + e.message);
    }
    departureNoticesByPerson[person.key] = results;

    try {
      sendDepartureNotices_(person.key, person.label, targetDate, isFinal, results,
        getPersonNotifyRecipients_(config, person.key), dangerWarningPrefix, riverSuffix);
    } catch (e) {
      Logger.log(person.label + 'の出発まわりの通知の送信処理でエラー: ' + e.message);
    }
  });

  // 確定版配信時のみ、帰りの少し前に「帰りの雨雲通過予報」・車送迎の直前アラートを予約する
  if (isFinal) {
    try {
      scheduleHomewardRainAlerts_(targetDate, calendarId);
    } catch (e) {
      Logger.log('帰りの雨雲アラートの予約処理でエラー: ' + e.message);
    }
    try {
      scheduleCarPickupAlerts_(targetDate, calendarId, departureNoticesByPerson);
    } catch (e) {
      Logger.log('車送迎の直前アラートの予約処理でエラー: ' + e.message);
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
  lines.push('【ゆうき】' + dateLabel + ' 登校 天気予報 - ' + versionLabel);

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

// ==== みつきさん向けメッセージ文面の組み立て(登校・自転車通学の出発時刻お知らせ。項目B) ====
// 送迎提案・徒歩提案は出さない。雨天時はカッパの準備を知らせる。
function buildMitsukiSchoolCommuteMessage_(targetDate, result, isFinal) {
  const dateLabel = formatDateLabelJa_(targetDate);
  const versionLabel = isFinal ? '確定版' : '暫定版';
  const startLabel = Utilities.formatDate(result.startTime, 'Asia/Tokyo', 'H:mm');
  const departureLabel = Utilities.formatDate(result.departureTime, 'Asia/Tokyo', 'H:mm');

  const lines = [];
  lines.push('【みつき】' + dateLabel + ' 登校 出発時刻のお知らせ - ' + versionLabel);
  lines.push('予定: ' + result.label + '(' + startLabel + '〜)');
  if (result.pop !== null) {
    lines.push('降水確率: ' + result.pop + '%');
  }
  if (result.isRaining) {
    lines.push('雨天のためカッパを準備してください。');
  }
  const detailParts = ['自転車で約' + result.travelMinutes + '分'];
  if (result.isRaining) {
    detailParts.push('雨天バッファ+' + result.bufferMin + '分');
  }
  lines.push('家を出る目安: ' + departureLabel + '頃(' + detailParts.join(' + ') + ')');
  const sourceLine = buildSourceLinksLine_(result.usedPop, false);
  if (sourceLine) lines.push(sourceLine);
  if (!isFinal) {
    lines.push('※当日6:30頃に確定版をお送りします');
  }
  return lines.join('\n');
}

/**
 * 出発まわりの通知(項目A)
 * ------------------------------------------------------------
 * ゆうき・みつき共通。対象は非登校日の時刻付き予定すべて、登校日は「家から向かう習い事」のみ
 * (Config.gsのgetDepartureNoticeTargets_)。1予定につき1通、暫定版は必ず送り、確定版は
 * 暫定版時点のスナップショットと比較して判断が変わった場合のみ送る。
 * ------------------------------------------------------------
 */
const DEPARTURE_NOTICE_SNAPSHOT_PREFIX_ = 'DEPARTURE_NOTICE_SNAPSHOT_';

function departureNoticeSnapshotKey_(personKey, targetDate) {
  return DEPARTURE_NOTICE_SNAPSHOT_PREFIX_ + personKey + '_' + Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyyMMdd');
}

// 差分比較用に、送信に必要な最小限のフィールドだけをスナップショットとして保存する
function toDepartureNoticeSnapshot_(result) {
  if (result.mode === 'CAR') {
    return { label: result.label, mode: 'CAR', startTime: result.startTime.toISOString() };
  }
  return {
    label: result.label,
    mode: 'BIKE',
    startTime: result.startTime.toISOString(),
    departureTime: result.departureTime.toISOString(),
    isRaining: result.isRaining,
    escortNeeded: result.escortNeeded,
  };
}

// 暫定版スナップショットと比較し、変更点の説明(なければnull=送信不要)を返す。
// 一致する予定名が無ければ「新規の予定」として扱う。
function diffDepartureNotice_(result, previousSnapshots) {
  const prev = (previousSnapshots || []).find(function (s) { return s.label === result.label; });
  if (!prev) return '新規の予定です(暫定版の時点ではこの予定はありませんでした)。';

  const changes = [];
  const startLabel = Utilities.formatDate(result.startTime, 'Asia/Tokyo', 'H:mm');
  const prevStartLabel = Utilities.formatDate(new Date(prev.startTime), 'Asia/Tokyo', 'H:mm');
  if (startLabel !== prevStartLabel) changes.push('予定時刻: ' + prevStartLabel + ' → ' + startLabel);

  if (result.mode !== prev.mode) {
    changes.push('移動手段が変わりました(' + prev.mode + ' → ' + result.mode + ')');
  } else if (result.mode === 'BIKE') {
    const depLabel = Utilities.formatDate(result.departureTime, 'Asia/Tokyo', 'H:mm');
    const prevDepLabel = Utilities.formatDate(new Date(prev.departureTime), 'Asia/Tokyo', 'H:mm');
    if (depLabel !== prevDepLabel) changes.push('出発目安: ' + prevDepLabel + ' → ' + depLabel);
    if (result.isRaining !== prev.isRaining) {
      changes.push(result.isRaining ? '雨天予報に変わりました(カッパ推奨)' : '雨天予報が解消しました');
    }
    if (result.escortNeeded !== prev.escortNeeded) {
      changes.push(result.escortNeeded ? '車送迎の検討が必要になりました' : '車送迎は不要になりました');
    }
  }

  return changes.length > 0 ? changes.join(' / ') : null;
}

// ==== 出発まわりの通知を、暫定版/確定版の別に応じて送信する ====
function sendDepartureNotices_(personKey, personLabel, targetDate, isFinal, results, recipients, dangerWarningPrefix, riverSuffix) {
  const dateStr = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  const props = PropertiesService.getScriptProperties();
  const snapshotKey = departureNoticeSnapshotKey_(personKey, targetDate);

  if (!isFinal) {
    if (results.length === 0) {
      Logger.log(personLabel + ': ' + dateStr + ' は出発まわりの通知の対象予定が無いためスキップしました。');
      props.deleteProperty(snapshotKey);
      return;
    }
    results.forEach(function (result) {
      const message = dangerWarningPrefix + buildDepartureNoticeMessage_(targetDate, personLabel, result, isFinal, null) + riverSuffix;
      sendLinePushToRecipients_(recipients, message);
    });
    props.setProperty(snapshotKey, JSON.stringify(results.map(toDepartureNoticeSnapshot_)));
    return;
  }

  // 確定版: 暫定版スナップショットと比較し、変更があった予定のみ送る
  const storedRaw = props.getProperty(snapshotKey);
  const previousSnapshots = storedRaw ? JSON.parse(storedRaw) : null;
  if (results.length === 0) {
    Logger.log(personLabel + ': ' + dateStr + ' は出発まわりの通知の対象予定が無いためスキップしました。');
  } else {
    results.forEach(function (result) {
      const diff = diffDepartureNotice_(result, previousSnapshots);
      if (!diff) {
        Logger.log(personLabel + ': 「' + result.label + '」は暫定版から変更がないため確定版の送信をスキップしました。');
        return;
      }
      const message = dangerWarningPrefix + buildDepartureNoticeMessage_(targetDate, personLabel, result, isFinal, diff) + riverSuffix;
      sendLinePushToRecipients_(recipients, message);
    });
  }
  props.deleteProperty(snapshotKey); // この日の確定版処理が終わったらスナップショットは不要
}

// ==== 出発まわりの通知のメッセージ文面(CARモード/BIKEモードで内容が異なる) ====
function buildDepartureNoticeMessage_(targetDate, personLabel, result, isFinal, diffDescription) {
  const dateLabel = formatDateLabelJa_(targetDate);
  const versionLabel = isFinal ? '確定版' : '暫定版';
  const startLabel = Utilities.formatDate(result.startTime, 'Asia/Tokyo', 'H:mm');

  const lines = [];
  lines.push('【' + personLabel + '】' + dateLabel + ' ' + result.label + ' 出発まわりの通知 - ' + versionLabel);
  if (diffDescription) {
    lines.push('(' + diffDescription + ')');
  }

  if (result.mode === 'CAR') {
    // 車送迎固定(項目A-2)。自転車換算・降水判定・カッパ準備・送迎要否判断は行わない。
    // 送迎の手配は本人の責任という方針のため、文面は本人に連絡を促す形にする。
    lines.push(result.label + 'は' + startLabel + 'からです。車送迎の担当の方に連絡リマインドしてください。');
    lines.push('行きの出発目安: ' + startLabel + '頃');
    if (result.pickupTime) {
      lines.push('帰りのお迎え目安: ' + Utilities.formatDate(result.pickupTime, 'Asia/Tokyo', 'H:mm') + '頃');
    } else {
      lines.push('帰りのお迎え目安: 算出できませんでした(帰りの予定が不明なため、別途ご確認ください)');
    }
  } else {
    lines.push('予定: ' + result.label + '(' + startLabel + '〜)');
    if (result.pop !== null) {
      lines.push('降水確率: ' + result.pop + '%');
    }
    if (result.isRaining) {
      lines.push('雨天のためカッパを準備してください。自転車を推奨します。');
    } else {
      lines.push('自転車を推奨します。');
    }
    const departureLabel = Utilities.formatDate(result.departureTime, 'Asia/Tokyo', 'H:mm');
    const detailParts = ['自転車で約' + result.travelMinutes + '分'];
    if (result.isRaining) detailParts.push('雨天バッファ+' + result.bufferMin + '分');
    lines.push('家を出る目安: ' + departureLabel + '頃(' + detailParts.join(' + ') + ')');

    if (result.escortNeeded) {
      const rainyLegs = [];
      if (result.go.rainy) rainyLegs.push('行き');
      if (result.ret.rainy) rainyLegs.push('帰り');
      lines.push('車での送迎: 検討してください(' + rainyLegs.join('・') + 'が雨天のため)。');
    } else {
      lines.push('車での送迎: 必要なさそうです。');
    }
  }

  const sourceLine = buildSourceLinksLine_(result.usedPop || false, false);
  if (sourceLine) lines.push(sourceLine);

  if (!isFinal) {
    lines.push('※判断に変更があれば当日6:30頃に確定版をお送りします');
  }
  return lines.join('\n');
}

/**
 * 帰りの雨雲通過予報(項目D)
 * ------------------------------------------------------------
 * 確定版配信時(sendFinalNotification)に、ゆうき・みつきそれぞれの帰り予定時刻(getHomewardDepartureTime_)の
 * HOMEWARD_ALERT_LEAD_MIN分前(デフォルト30分)に発火する使い捨てトリガーを予約する。
 * 既存の「家族スケジュール自動登録.gs」のscheduleNotification_/runScheduledNotifications_と同じ、
 * スクリプトプロパティ+使い捨てトリガーによる予約パターンを踏襲している。
 * 登校日かどうかで「下校予定」「帰りの予定」と文言を出し分ける(非登校日は登校/下校を前提にしない)。
 * ------------------------------------------------------------
 */
const HOMEWARD_ALERT_PENDING_PREFIX_ = 'PENDING_HOMEWARD_ALERT_';

// ==== 確定版配信時に、ゆうき・みつき双方の帰りの雨雲アラートを予約する ====
function scheduleHomewardRainAlerts_(targetDate, calendarId) {
  const config = getWeatherConfig_();
  const leadMin = config.homewardAlertLeadMin;

  scheduleHomewardRainAlertFor_('YUKI', 'ゆうき', targetDate, calendarId, '【ゆうき】',
    getYukiDefaultSchoolEnd_(), YUKI_ROUTE_CHECK_KEYS_, leadMin, YUKI_LESSON_NAMES_);
  // 英語・お茶は「学校から家に向かう予定」ではない(いったん帰宅してから家庭発で出発する)ため、
  // 帰り予定時刻の算出対象からは除外する(含めると帰り時刻が大幅に後ろへずれ、アラートの発火予約も
  // 連動してずれてしまうバグになる)。
  scheduleHomewardRainAlertFor_('MITSUKI', 'みつき', targetDate, calendarId, '【みつき】',
    getMitsukiDefaultSchoolEnd_(), ['HOME', 'SCHOOL_MITSUKI'], leadMin, MITSUKI_LESSON_NAMES_);
}

function scheduleHomewardRainAlertFor_(personKey, personLabel, targetDate, calendarId, namePrefix, defaultEndTime, routeKeys, leadMin, excludeLabelKeywords) {
  const homeward = getHomewardDepartureTime_(targetDate, calendarId, namePrefix, defaultEndTime, excludeLabelKeywords);
  if (!homeward) {
    Logger.log(personLabel + ': 帰りの予定が無いため、帰りの雨雲アラートは予約しませんでした。');
    return;
  }
  const alertTime = new Date(homeward.time.getTime() - leadMin * 60 * 1000);
  if (alertTime.getTime() <= Date.now()) {
    Logger.log(personLabel + ': 帰りの予定時刻(' + homeward.time + ')が近すぎる/過去のため、帰りの雨雲アラートは予約しませんでした。');
    return;
  }

  const isSchoolDayFlag = isSchoolDay_(targetDate, calendarId, namePrefix);
  const props = PropertiesService.getScriptProperties();
  const key = HOMEWARD_ALERT_PENDING_PREFIX_ + personKey + '_' + Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyyMMdd');
  props.setProperty(key, JSON.stringify({
    personKey: personKey,
    personLabel: personLabel,
    routeKeys: routeKeys,
    scheduledAt: alertTime.toISOString(),
    homewardTime: homeward.time.toISOString(),
    isSchoolDay: isSchoolDayFlag,
  }));
  ScriptApp.newTrigger('runScheduledHomewardAlerts_').timeBased().at(alertTime).create();
  Logger.log(personLabel + ': 帰りの雨雲アラートを' + alertTime + 'に予約しました(帰り予定 ' + homeward.time + ')。');
}

// ==== 予約された帰りの雨雲アラートを、実際の時刻が来たら送信する(使い捨てトリガーから呼ばれる) ====
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
      const message = buildHomewardRainAlertMessage_(data.personLabel, new Date(data.homewardTime), rainSpotDetails, !!data.isSchoolDay);
      sendLinePushToRecipients_(getPersonNotifyRecipients_(config, data.personKey), message);
    } catch (err) {
      Logger.log('帰りの雨雲アラートの送信でエラー(' + data.personLabel + '): ' + err.message);
    }
  });
}

// ==== 帰りの雨雲通過予報のメッセージ文面(交通手段の提案は含めない、実測・予測値のみ) ====
// 登校日かどうかで「下校予定」「帰りの予定」と文言を出し分ける(項目D)。
function buildHomewardRainAlertMessage_(personLabel, homewardTime, rainSpotDetails, isSchoolDayFlag) {
  const timeLabel = Utilities.formatDate(homewardTime, 'Asia/Tokyo', 'H:mm');
  const noticeTitle = isSchoolDayFlag ? '下校時 雨雲通過予報' : '帰り 雨雲通過予報';
  const scheduleLabel = isSchoolDayFlag ? '下校予定' : '帰りの予定';
  const lines = [];
  lines.push('【' + personLabel + '】' + noticeTitle);
  lines.push(scheduleLabel + '(' + timeLabel + '頃)にかけての雨雲の様子:');
  if (rainSpotDetails.length === 0) {
    lines.push('雨雲情報を取得できませんでした。');
  } else {
    rainSpotDetails.forEach(function (spot) {
      lines.push('・' + spot.label + ': ' + spot.mmh + 'mm/h');
    });
  }
  const sourceLine = buildSourceLinksLine_(false, rainSpotDetails.length > 0);
  if (sourceLine) lines.push(sourceLine);
  const riverLine = buildRiverLevelInfoLine_();
  if (riverLine) lines.push(riverLine);
  return lines.join('\n');
}

/**
 * 車送迎の直前アラート(項目A-2)
 * ------------------------------------------------------------
 * 出発まわりの通知(項目A)でCARモード(現状は英語のみ)と判定された予定について、
 * 開始のCAR_PICKUP_ALERT_LEAD_MIN分前(デフォルト60分・Config.gs)に発火する使い捨てトリガーを予約する。
 * 帰りの雨雲アラート(scheduleHomewardRainAlerts_)と同じ、スクリプトプロパティ+
 * 使い捨てトリガーによる予約パターンを踏襲している。送迎の手配は本人の責任という方針のため、
 * 内容は「連絡リマインド」に徹し、自転車換算・降水判定は行わない。
 * ------------------------------------------------------------
 */
const CAR_PICKUP_ALERT_PENDING_PREFIX_ = 'PENDING_CAR_PICKUP_ALERT_';

// ==== 確定版配信時に、出発まわりの通知でCARモードだった予定それぞれの直前アラートを予約する ====
function scheduleCarPickupAlerts_(targetDate, calendarId, departureNoticesByPerson) {
  const leadMin = getCarPickupAlertLeadMin_();

  ['YUKI', 'MITSUKI'].forEach(function (personKey) {
    const personLabel = personKey === 'YUKI' ? 'ゆうき' : 'みつき';
    const carTargets = (departureNoticesByPerson[personKey] || []).filter(function (r) { return r.mode === 'CAR'; });
    if (carTargets.length === 0) return;

    carTargets.forEach(function (target, index) {
      const alertTime = new Date(target.startTime.getTime() - leadMin * 60 * 1000);
      if (alertTime.getTime() <= Date.now()) {
        Logger.log(personLabel + ': ' + target.label + '(' + target.startTime + ')の開始時刻が近すぎる/過去のため、車送迎の直前アラートは予約しませんでした。');
        return;
      }

      const props = PropertiesService.getScriptProperties();
      const key = CAR_PICKUP_ALERT_PENDING_PREFIX_ + personKey + '_' + Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyyMMdd') + '_' + index;
      props.setProperty(key, JSON.stringify({
        personKey: personKey,
        personLabel: personLabel,
        label: target.label,
        startTime: target.startTime.toISOString(),
        pickupTime: target.pickupTime ? target.pickupTime.toISOString() : null,
        scheduledAt: alertTime.toISOString(),
      }));
      ScriptApp.newTrigger('runScheduledCarPickupAlerts_').timeBased().at(alertTime).create();
      Logger.log(personLabel + ': ' + target.label + 'の車送迎直前アラートを' + alertTime + 'に予約しました(開始予定 ' + target.startTime + ')。');
    });
  });
}

// ==== 予約された車送迎の直前アラートを、実際の時刻が来たら送信する(使い捨てトリガーから呼ばれる) ====
function runScheduledCarPickupAlerts_(e) {
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
    if (key.indexOf(CAR_PICKUP_ALERT_PENDING_PREFIX_) !== 0) return;
    const data = JSON.parse(allProps[key]);
    // まだこのアラートの予定時刻に達していなければ、他の予定のトリガーからの呼び出しとみなしスキップする
    if (new Date(data.scheduledAt).getTime() > now + 60 * 1000) return;

    props.deleteProperty(key); // 二重送信防止のため、処理対象として取り出した時点で先に削除

    try {
      const message = buildCarPickupAlertMessage_(data.personLabel, data.label,
        new Date(data.startTime), data.pickupTime ? new Date(data.pickupTime) : null);
      sendLinePushToRecipients_(getPersonNotifyRecipients_(config, data.personKey), message);
    } catch (err) {
      Logger.log('車送迎の直前アラートの送信でエラー(' + data.label + '): ' + err.message);
    }
  });
}

// ==== 車送迎の直前アラートのメッセージ文面 ====
function buildCarPickupAlertMessage_(personLabel, label, startTime, pickupTime) {
  const startLabel = Utilities.formatDate(startTime, 'Asia/Tokyo', 'H:mm');
  const lines = [];
  lines.push('【' + personLabel + '】' + label + ' 出発まわりの通知(直前)');
  lines.push('まもなく' + startLabel + 'から' + label + 'です。車送迎の担当の方に連絡リマインドしてください。');
  if (pickupTime) {
    lines.push('帰りのお迎え目安: ' + Utilities.formatDate(pickupTime, 'Asia/Tokyo', 'H:mm') + '頃');
  }
  return lines.join('\n');
}

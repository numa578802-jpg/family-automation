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
 *      「家から向かう習い事」のみが対象。CAR(英語)/BIKE(自転車)/TRANSIT(ゆうきの非登校日部活。
 *      自宅→(車)若林駅→(電車)刈谷市駅→(徒歩)学校)の3モードで文面・計算が異なる。
 *      暫定版は必ず送るが、確定版は暫定版から判断が変わった場合のみ送る。
 *   4. 帰りの雨雲通過予報(ゆうき・みつき共通) … 帰り予定時刻の少し前に発火する使い捨てトリガー
 *   5. 直前アラート(出発まわりの通知でCAR/TRANSITモードの予定) … 家を出る目安(departureTime)の
 *      何分前か(CAR_PICKUP_ALERT_LEAD_MIN)に発火する使い捨てトリガー。本人+一志さん・きくみさん(CC)宛。
 *   6. 自転車の出発直前アラート(出発まわりの通知でBIKEモードの予定) … 出発目安の何分前か
 *      (BIKE_DEPARTURE_ALERT_LEAD_MIN)に発火する使い捨てトリガー。本人のみ宛(CCなし)。
 *   7. 迎えの連絡リマインド(出発まわりの通知でCAR/TRANSITモードの予定) … 終了時刻を基準に発火する
 *      使い捨てトリガー。CARは終了時刻のPICKUP_REMINDER_LEAD_MIN_CAR分前、TRANSITは終了時刻ちょうど。
 *      本人+一志さん・きくみさん(CC)宛、天気情報は付けない。
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
  // 未実装のため常にnullを返す暫定実装)。河川水位情報リンクは、送信の共通経路
  // (sendLinePushMessage_、WeatherNotify_Line.gs)が全メッセージの末尾に一律で付与するため、
  // ここでは扱わない(項目A1。付け忘れを防ぐため、メッセージ種類ごとに個別対応しない設計)。
  let dangerWarningPrefix = '';
  if (isFinal) {
    try {
      const warningLine = buildDangerWarningLine_(checkDangerWarnings_());
      if (warningLine) dangerWarningPrefix = warningLine + '\n\n';
    } catch (e) {
      Logger.log('危険警報チェックの呼び出しでエラー(通知全体は続行します): ' + e.message);
    }
  }

  // ゆうきさん(バス/自転車提案。朝・帰り往復で判定) → ゆうき本人 + 一志さん・きくみさん(CC、内容確認用)
  try {
    if (isYukiSchoolDay_(targetDate, calendarId)) {
      const result = decideYukiTransport_(targetDate, isFinal, calendarId);
      const message = dangerWarningPrefix + buildYukiMessage_(targetDate, result, isFinal);
      sendLinePushToRecipients_(getPersonNotifyRecipients_(config, 'YUKI'), message);
    } else {
      Logger.log('ゆうきさん: ' + dateStr + ' は登校日ではないため登校 天気予報をスキップしました。');
    }
  } catch (e) {
    Logger.log('ゆうきさんの登校 天気予報処理でエラー: ' + e.message);
  }

  // 出発まわりの通知(ゆうき・みつき共通。項目A・項目A2で統合) → 本人 + 一志さん・きくみさん(CC)
  // 項目A2: みつきさんは登校(自転車通学)+その日の家庭発の習い事・部活等を1人1通に統合する
  // (decideMitsukiCombinedNotices_)。ゆうきさんも同日に複数の対象があれば1通にまとめる。
  // 項目A1: 暫定版は対象が1件以上あれば必ず送る。確定版は「常に送る」(暫定版から変化が無くても、
  // 最新の天気で計算し直して送る。変わった点があれば冒頭に併記し、無ければ「変更なし」と書く)。
  const departureNoticesByPerson = {};
  [
    { key: 'YUKI', label: 'ゆうき', compute: function () { return decideYukiDepartureNotices_(targetDate, calendarId); } },
    { key: 'MITSUKI', label: 'みつき', compute: function () { return decideMitsukiCombinedNotices_(targetDate, calendarId); } },
  ].forEach(function (person) {
    let sections = [];
    try {
      sections = person.compute();
    } catch (e) {
      Logger.log(person.label + 'の出発まわりの通知の算出でエラー: ' + e.message);
    }
    departureNoticesByPerson[person.key] = sections;

    try {
      sendCombinedDepartureNotices_(person.key, person.label, targetDate, isFinal, sections,
        getPersonNotifyRecipients_(config, person.key), dangerWarningPrefix);
    } catch (e) {
      Logger.log(person.label + 'の出発まわりの通知の送信処理でエラー: ' + e.message);
    }
  });

  // 確定版配信時のみ、帰りの少し前に各種アラートを予約する
  if (isFinal) {
    try {
      scheduleHomewardRainAlerts_(targetDate, calendarId);
    } catch (e) {
      Logger.log('帰りの雨雲アラートの予約処理でエラー: ' + e.message);
    }
    try {
      // 項目A3: ゆうきさんの非登校日部活(TRANSITモード)は、帰りの雨雲アラート+迎えの連絡を統合した
      // 専用の通知(scheduleYukiStationNotices_)で扱うため、ここでscheduleHomewardRainAlerts_とは別に呼ぶ。
      scheduleYukiStationNotices_(targetDate, calendarId, departureNoticesByPerson.YUKI);
    } catch (e) {
      Logger.log('ゆうきの迎えの連絡+帰りの雨雲アラートの予約処理でエラー: ' + e.message);
    }
    try {
      // 項目A6: みつきさんの家庭発の習い事(お茶等、BIKEモード)の帰りの雨雲アラート
      scheduleMitsukiLessonRainAlerts_(targetDate, calendarId, departureNoticesByPerson.MITSUKI);
    } catch (e) {
      Logger.log('みつきの習い事帰りの雨雲アラートの予約処理でエラー: ' + e.message);
    }
    try {
      scheduleCarPickupAlerts_(targetDate, calendarId, departureNoticesByPerson);
    } catch (e) {
      Logger.log('直前アラートの予約処理でエラー: ' + e.message);
    }
    try {
      schedulePickupReminders_(targetDate, calendarId, departureNoticesByPerson);
    } catch (e) {
      Logger.log('迎えの連絡リマインドの予約処理でエラー: ' + e.message);
    }
    try {
      scheduleBikeDepartureAlerts_(targetDate, calendarId, departureNoticesByPerson);
    } catch (e) {
      Logger.log('自転車の出発直前アラートの予約処理でエラー: ' + e.message);
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
  // 項目A3: 出発目安は天候によらず固定(既定7:50)。雨天バッファではなく余裕(ARRIVAL_MARGIN_SCHOOL_MIN)で表記する。
  const detailParts = ['自転車で約' + result.travelMinutes + '分', '余裕' + result.marginMin + '分'];
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
    // 項目A4: 出発目安・お迎え目安(終了時刻)の変化も検知できるよう、endTime/pickupTimeを保持する
    return {
      label: result.label,
      mode: 'CAR',
      startTime: result.startTime.toISOString(),
      endTime: result.endTime ? result.endTime.toISOString() : null,
      departureTime: result.departureTime.toISOString(),
      pickupTime: result.pickupTime ? result.pickupTime.toISOString() : null,
    };
  }
  if (result.mode === 'TRANSIT') {
    // 項目A4: 終了時刻の変化も検知できるよう、endTimeを保持する
    return {
      label: result.label,
      mode: 'TRANSIT',
      startTime: result.startTime.toISOString(),
      endTime: result.endTime ? result.endTime.toISOString() : null,
      departureTime: result.departureTime.toISOString(),
    };
  }
  if (result.mode === 'SCHOOL_COMMUTE') {
    return {
      label: result.label,
      mode: 'SCHOOL_COMMUTE',
      startTime: result.startTime.toISOString(),
      departureTime: result.departureTime.toISOString(),
      isRaining: result.isRaining,
    };
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

  // 任意のDateフィールド(終了時刻等、値が無いことがあるもの)の変化を比較するヘルパー(項目A4)
  function pushOptionalTimeChange_(fieldLabel, newDate, prevIso) {
    if (newDate && prevIso) {
      const newLabel = Utilities.formatDate(newDate, 'Asia/Tokyo', 'H:mm');
      const prevLabel = Utilities.formatDate(new Date(prevIso), 'Asia/Tokyo', 'H:mm');
      if (newLabel !== prevLabel) changes.push(fieldLabel + ': ' + prevLabel + ' → ' + newLabel);
    } else if (newDate && !prevIso) {
      changes.push(fieldLabel + 'が算出できるようになりました: ' + Utilities.formatDate(newDate, 'Asia/Tokyo', 'H:mm'));
    } else if (!newDate && prevIso) {
      changes.push(fieldLabel + 'が算出できなくなりました');
    }
  }

  if (result.mode !== prev.mode) {
    changes.push('移動手段が変わりました(' + prev.mode + ' → ' + result.mode + ')');
  } else if (result.mode === 'CAR') {
    // 項目A4(今回新設): みつきの英語等、CARモードは以前は予定時刻(startTime)の変化しか検知していなかった。
    // 出発目安・お迎え目安(終了時刻)の変化も検知するようにした。
    pushOptionalTimeChange_('出発目安', result.departureTime, prev.departureTime);
    pushOptionalTimeChange_('帰りのお迎え目安', result.pickupTime, prev.pickupTime);
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
  } else if (result.mode === 'TRANSIT') {
    const depLabel = Utilities.formatDate(result.departureTime, 'Asia/Tokyo', 'H:mm');
    const prevDepLabel = Utilities.formatDate(new Date(prev.departureTime), 'Asia/Tokyo', 'H:mm');
    if (depLabel !== prevDepLabel) changes.push('家を出る目安: ' + prevDepLabel + ' → ' + depLabel);
    // 項目A4(今回新設): 終了時刻の変化も検知する
    pushOptionalTimeChange_('終了予定', result.endTime, prev.endTime);
  } else if (result.mode === 'SCHOOL_COMMUTE') {
    const depLabel = Utilities.formatDate(result.departureTime, 'Asia/Tokyo', 'H:mm');
    const prevDepLabel = Utilities.formatDate(new Date(prev.departureTime), 'Asia/Tokyo', 'H:mm');
    if (depLabel !== prevDepLabel) changes.push('家を出る目安: ' + prevDepLabel + ' → ' + depLabel);
    if (result.isRaining !== prev.isRaining) {
      changes.push(result.isRaining ? '雨天予報に変わりました(カッパ推奨)' : '雨天予報が解消しました');
    }
  }

  return changes.length > 0 ? changes.join(' / ') : null;
}

/**
 * 出発まわりの通知(統合版)を、暫定版/確定版の別に応じて送信する(項目A1・A2)。
 * 1人につき、その日の対象セクション(登校・習い事・部活等)をまとめて1通で送る。
 * ------------------------------------------------------------
 * ・暫定版: 対象セクションが1件以上あれば必ず送る(0件ならスキップ。項目A2「対象の項目が
 *   1つもない日は出さない」)。
 * ・確定版(項目A1で改訂): 暫定版から変化が無くても常に送る。最新の天気で計算し直し、
 *   変わった点があれば冒頭に「(◯◯: ...)」の形で併記し、無ければ「(変更なし)」と書く
 *   (buildCombinedDiffSummary_)。暫定版・確定版とも対象が0件であればスキップする
 *   (ただし暫定版で送ったのに確定版で対象が0件になった=全て無くなった場合は、その旨を
 *   知らせるため確定版を送る。buildCombinedDiffSummary_の「予定が無くなりました」参照)。
 * ・項目A5: 暫定版が対象0件だった場合もスナップショットは削除せず空配列[]を保存する
 *   (プロパティ自体が無い=暫定版が実行されていない、というケースと区別するため)。
 *   確定版側でスナップショットがnull(=暫定版が実行されていない)の場合は、新規に追加された
 *   予定を1件ずつ「新規の予定です」と列挙せず、「(暫定版なし)」とだけ冒頭に出す。
 * ------------------------------------------------------------
 */
function sendCombinedDepartureNotices_(personKey, personLabel, targetDate, isFinal, sections, recipients, dangerWarningPrefix) {
  const dateStr = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  const props = PropertiesService.getScriptProperties();
  const snapshotKey = departureNoticeSnapshotKey_(personKey, targetDate);

  if (!isFinal) {
    if (sections.length === 0) {
      Logger.log(personLabel + ': ' + dateStr + ' は出発まわりの通知の対象が無いためスキップしました。');
      // 項目A5: 削除ではなく空配列を保存する。プロパティ自体が無い(=暫定版が実行されていない)場合と
      // 区別できるようにするため(確定版側のbuildCombinedDiffSummary_参照)。
      props.setProperty(snapshotKey, JSON.stringify([]));
      return;
    }
    const message = dangerWarningPrefix + buildCombinedDepartureMessage_(targetDate, personLabel, sections, isFinal, null);
    sendLinePushToRecipients_(recipients, message);
    props.setProperty(snapshotKey, JSON.stringify(sections.map(toDepartureNoticeSnapshot_)));
    return;
  }

  // 確定版(項目A1: 常に送る)
  const storedRaw = props.getProperty(snapshotKey);
  const previousSnapshots = storedRaw ? JSON.parse(storedRaw) : null;

  if (sections.length === 0 && (!previousSnapshots || previousSnapshots.length === 0)) {
    Logger.log(personLabel + ': ' + dateStr + ' は出発まわりの通知の対象が無いためスキップしました。');
    props.deleteProperty(snapshotKey);
    return;
  }

  const diffSummary = buildCombinedDiffSummary_(sections, previousSnapshots);
  const message = dangerWarningPrefix + buildCombinedDepartureMessage_(targetDate, personLabel, sections, isFinal, diffSummary);
  sendLinePushToRecipients_(recipients, message);
  props.deleteProperty(snapshotKey); // この日の確定版処理が終わったらスナップショットは不要
}

// ==== 確定版の冒頭に出す変更点の要約(項目A1)。変化が無ければ「変更なし」を返す ====
function buildCombinedDiffSummary_(sections, previousSnapshots) {
  // 項目A5: previousSnapshotsがnull(=プロパティ自体が無い。前日の暫定版が実行されていない)場合は、
  // 各予定を「新規の予定です」と列挙せず、その旨だけをまとめて1回報告する。暫定版が実行されて
  // 対象が0件だった日(previousSnapshotsは空配列[])は、この分岐に入らず従来どおり「新規の予定です」になる。
  if (previousSnapshots === null) {
    return '暫定版なし';
  }
  const parts = [];
  sections.forEach(function (result) {
    const diff = diffDepartureNotice_(result, previousSnapshots);
    if (diff) parts.push(result.label + ': ' + diff);
  });
  // 暫定版の時点にはあったが、確定版の対象からは外れた(=予定が無くなった)ものも変化として報告する
  (previousSnapshots || []).forEach(function (prev) {
    const stillExists = sections.some(function (s) { return s.label === prev.label; });
    if (!stillExists) {
      parts.push(prev.label + ': 予定が無くなりました(暫定版の時点ではありましたが、確定版の対象からは外れました)');
    }
  });
  return parts.length > 0 ? parts.join(' / ') : '変更なし';
}

// ==== 出発まわりの通知1セクション分の本文(見出し・出典リンクは含まない)。CAR/TRANSIT/BIKE/SCHOOL_COMMUTEで内容が異なる ====
function buildDepartureNoticeSectionLines_(result) {
  const startLabel = Utilities.formatDate(result.startTime, 'Asia/Tokyo', 'H:mm');
  const lines = [];

  if (result.mode === 'SCHOOL_COMMUTE') {
    // 項目A2: みつきさんの登校(自転車通学)。送迎提案・徒歩提案は出さない。雨天時はカッパの準備を知らせる。
    const departureLabel = Utilities.formatDate(result.departureTime, 'Asia/Tokyo', 'H:mm');
    lines.push('予定: ' + result.label + '(' + startLabel + '〜)');
    if (result.pop !== null) {
      lines.push('降水確率: ' + result.pop + '%');
    } else {
      // 項目A4: ゆうきさんの朝の通知と表現を揃える(黙って省略しない)
      lines.push('降水確率を取得できませんでした。');
    }
    if (result.isRaining) {
      lines.push('雨天のためカッパを準備してください。');
    }
    const detailParts = ['自転車で約' + result.travelMinutes + '分', '余裕' + result.marginMin + '分'];
    lines.push('家を出る目安: ' + departureLabel + '頃(' + detailParts.join(' + ') + ')');
  } else if (result.mode === 'CAR') {
    // 車送迎固定(項目A-2)。自転車換算・降水判定・カッパ準備・送迎要否判断は行わない。
    // 送迎の手配は本人の責任という方針のため、文面は本人に連絡を促す形にする。
    // 行きの出発目安=予定開始時刻から車移動時間の仮値(CAR_TRAVEL_MINUTES_DEFAULT)を引いた時刻、
    // 帰りのお迎え目安=この予定自身の終了時刻(項目1で修正。以前はその日全体の帰り予定を誤って
    // 流用しており、開始前の時刻が出るバグがあった)。
    lines.push(result.label + 'は' + startLabel + 'からです。車送迎の担当の方に連絡リマインドしてください。');
    lines.push('行きの出発目安: ' + Utilities.formatDate(result.departureTime, 'Asia/Tokyo', 'H:mm') + '頃');
    if (result.pickupTime) {
      lines.push('帰りのお迎え目安: ' + Utilities.formatDate(result.pickupTime, 'Asia/Tokyo', 'H:mm') + '頃');
    } else {
      lines.push('帰りのお迎え目安: 算出できませんでした(帰りの予定が不明なため、別途ご確認ください)');
    }
  } else if (result.mode === 'TRANSIT') {
    // ゆうきさんの非登校日部活(項目A2)。自宅→(車)若林駅→(電車)刈谷市駅→(徒歩)学校の順に逆算する。
    // 車で送迎するのは若林駅までの区間のみのため、CARモードと同様「連絡リマインド」型の文面にする。
    const departureLabel = Utilities.formatDate(result.departureTime, 'Asia/Tokyo', 'H:mm');
    lines.push(startLabel + 'から刈谷で' + result.label + '。');
    lines.push(departureLabel + 'ごろ家を出る目安で若林駅へ(車)。');
    lines.push('車送迎の担当の方に連絡リマインドしてください。');
    if (result.pop !== null) {
      lines.push('降水確率: ' + result.pop + '%');
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
    if (result.isRaining && result.bufferMin > 0) detailParts.push('雨天バッファ+' + result.bufferMin + '分');
    lines.push('家を出る目安: ' + departureLabel + '頃(' + detailParts.join(' + ') + ')');

    // 項目A4: 行き・帰りいずれかの降水確率が取得できていない場合、escortNeeded=falseは
    // 「送迎不要と確認できた」のではなく「判定できなかった」だけなので、「必要なさそうです」とは
    // 出さず、ゆうきさんの朝の通知と同じ「降水確率を取得できませんでした」の表現に揃えて案内する。
    // 一方どちらかが雨天と確認できてescortNeeded=trueの場合は、データが揃っていなくても
    // そのまま案内する(もう片方が不明でも「検討してください」の判断は変わらないため)。
    if (result.escortNeeded) {
      const rainyLegs = [];
      if (result.go.rainy) rainyLegs.push('行き');
      if (result.ret.rainy) rainyLegs.push('帰り');
      lines.push('車での送迎: 検討してください(' + rainyLegs.join('・') + 'が雨天のため)。');
    } else if (result.go.usedPop && result.ret.usedPop) {
      lines.push('車での送迎: 必要なさそうです。');
    } else {
      lines.push('降水確率を取得できませんでした。送迎の要否は判断できません。');
    }
  }

  return lines;
}

// ==== 出発まわりの通知1件分のメッセージ(単体送信・診断用。本番の複数セクション統合送信はbuildCombinedDepartureMessage_を使う) ====
function buildDepartureNoticeMessage_(targetDate, personLabel, result, isFinal, diffDescription) {
  const dateLabel = formatDateLabelJa_(targetDate);
  const versionLabel = isFinal ? '確定版' : '暫定版';

  const lines = [];
  lines.push('【' + personLabel + '】' + dateLabel + ' ' + result.label + ' 出発まわりの通知 - ' + versionLabel);
  if (diffDescription) {
    lines.push('(' + diffDescription + ')');
  }
  lines.push.apply(lines, buildDepartureNoticeSectionLines_(result));

  const sourceLine = buildSourceLinksLine_(result.usedPop || false, false);
  if (sourceLine) lines.push(sourceLine);

  if (!isFinal) {
    lines.push('※当日6:30頃に確定版をお送りします'); // 項目A2: 確定版は常に送るため(項目A1)、「判断に変更があれば」の条件表現を外した
  }
  return lines.join('\n');
}

/**
 * 出発まわりの通知(統合版)のメッセージ文面(項目A2)。1人1通、複数セクション(登校・習い事・部活等)を
 * 「▼ 予定名」の見出しで区切って並べる。確定版はdiffSummaryText(buildCombinedDiffSummary_の結果、
 * 「変更なし」を含む)を冒頭に併記する(項目A1)。出典リンクは全セクションのusedPopをまとめて1回だけ出す。
 */
function buildCombinedDepartureMessage_(targetDate, personLabel, sections, isFinal, diffSummaryText) {
  const dateLabel = formatDateLabelJa_(targetDate);
  const versionLabel = isFinal ? '確定版' : '暫定版';

  const lines = [];
  lines.push('【' + personLabel + '】' + dateLabel + ' 出発まわりの通知 - ' + versionLabel);
  if (diffSummaryText) {
    lines.push('(' + diffSummaryText + ')');
  }

  sections.forEach(function (result, index) {
    if (index > 0) lines.push('');
    lines.push('▼ ' + result.label);
    lines.push.apply(lines, buildDepartureNoticeSectionLines_(result));
  });

  const usedPopAny = sections.some(function (s) { return s.usedPop; });
  const sourceLine = buildSourceLinksLine_(usedPopAny, false);
  if (sourceLine) lines.push(sourceLine);

  if (!isFinal) {
    lines.push('※当日6:30頃に確定版をお送りします'); // 項目A2: 確定版は常に送るため(項目A1)、「判断に変更があれば」の条件表現を外した
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

  // 項目A3: ゆうきさんの非登校日部活(TRANSITモード)は、帰りの雨雲アラート+迎えの連絡を統合した
  // 専用の通知(scheduleYukiStationNotices_)に置き換えたため、ここでは登校日のみ対象とする
  // (登校日の下校の雨雲アラートは、この統合の対象外・変更なし。項目A3のユーザー指示どおり)。
  if (isYukiSchoolDay_(targetDate, calendarId)) {
    scheduleHomewardRainAlertFor_('YUKI', 'ゆうき', targetDate, calendarId, '【ゆうき】',
      getYukiDefaultSchoolEnd_(), YUKI_ROUTE_CHECK_KEYS_, leadMin, YUKI_LESSON_NAMES_);
  } else {
    Logger.log('ゆうき: 非登校日のため、従来型の帰りの雨雲アラートはスキップしました(scheduleYukiStationNotices_に統合済み)。');
  }
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
  // 河川水位リンクは送信の共通経路(sendLinePushMessage_)が付与するため、ここでは付けない(項目A1)。
  return lines.join('\n');
}

/**
 * ゆうきさんの非登校日部活(TRANSITモード)の「迎えの連絡+帰りの雨雲アラート」(項目A3)
 * ------------------------------------------------------------
 * 以前は「帰りの雨雲アラート」(部活終了の30分前・HOMEWARD_ALERT_LEAD_MIN)と「迎えの連絡リマインド」
 * (部活終了ちょうど)の2件に分かれていたが、1件に統合した。確定版配信時に、部活終了の
 * YUKI_STATION_NOTICE_LEAD_MIN分前(既定10分)に発火する使い捨てトリガーを予約する。
 * 内容は5地点(YUKI_ROUTE_CHECK_KEYS_)の雨雲情報 + 「刈谷市駅で乗る電車が決まったら、迎えの担当の方へ
 * 若林駅の到着時刻を連絡してください。学校を出てから若林駅までは、YUKI_STATION_ARRIVAL_MIN_MIN〜
 * YUKI_STATION_ARRIVAL_MAX_MIN分ほどかかる見込みです。」という案内文。
 * 宛先はゆうき本人(登録済み)+一志さん・きくみさん(CC、YUKI_STATION_NOTICE_CCでオンオフ可能)。
 * 登校日の下校の雨雲アラート(scheduleHomewardRainAlerts_)は変更しない(項目A3のユーザー指示どおり)。
 * ------------------------------------------------------------
 */
const YUKI_STATION_NOTICE_PENDING_PREFIX_ = 'PENDING_YUKI_STATION_NOTICE_';

// ==== 確定版配信時に、ゆうきさんのTRANSITモードの予定それぞれの「迎えの連絡+帰りの雨雲アラート」を予約する ====
function scheduleYukiStationNotices_(targetDate, calendarId, yukiSections) {
  const leadMin = getYukiStationNoticeLeadMin_();
  const targets = (yukiSections || []).filter(function (r) { return r.mode === 'TRANSIT'; });
  if (targets.length === 0) return;

  targets.forEach(function (target, index) {
    if (!target.endTime) {
      Logger.log('ゆうき: ' + target.label + 'は終了時刻が不明なため、迎えの連絡+帰りの雨雲アラートは予約しませんでした。');
      return;
    }
    const alertTime = new Date(target.endTime.getTime() - leadMin * 60 * 1000);
    if (alertTime.getTime() <= Date.now()) {
      Logger.log('ゆうき: ' + target.label + '(終了予定 ' + target.endTime + ')が近すぎる/過去のため、迎えの連絡+帰りの雨雲アラートは予約しませんでした。');
      return;
    }

    const props = PropertiesService.getScriptProperties();
    const key = YUKI_STATION_NOTICE_PENDING_PREFIX_ + Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyyMMdd') + '_' + index;
    props.setProperty(key, JSON.stringify({
      label: target.label,
      endTime: target.endTime.toISOString(),
      scheduledAt: alertTime.toISOString(),
    }));
    ScriptApp.newTrigger('runScheduledYukiStationNotices_').timeBased().at(alertTime).create();
    Logger.log('ゆうき: ' + target.label + 'の迎えの連絡+帰りの雨雲アラートを' + alertTime + 'に予約しました(終了予定 ' + target.endTime + ')。');
  });
}

// ==== 予約された「迎えの連絡+帰りの雨雲アラート」を、実際の時刻が来たら送信する(使い捨てトリガーから呼ばれる) ====
function runScheduledYukiStationNotices_(e) {
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
    if (key.indexOf(YUKI_STATION_NOTICE_PENDING_PREFIX_) !== 0) return;
    const data = JSON.parse(allProps[key]);
    if (new Date(data.scheduledAt).getTime() > now + 60 * 1000) return;

    props.deleteProperty(key); // 二重送信防止のため、処理対象として取り出した時点で先に削除

    try {
      const rainSpotDetails = [];
      YUKI_ROUTE_CHECK_KEYS_.forEach(function (locKey) {
        const mmh = getMaxForecastRainfallMmh_(locKey);
        if (mmh !== null) rainSpotDetails.push({ label: WEATHER_LOCATIONS_[locKey].label, mmh: mmh });
      });
      const message = buildYukiStationNoticeMessage_(data.label, new Date(data.endTime), rainSpotDetails);
      sendLinePushToRecipients_(getYukiStationNoticeRecipients_(config), message);
    } catch (err) {
      Logger.log('ゆうきの迎えの連絡+帰りの雨雲アラートの送信でエラー(' + data.label + '): ' + err.message);
    }
  });
}

// ==== 宛先: 本人(登録済み)+一志さん・きくみさん(CC。YUKI_STATION_NOTICE_CCでオンオフ可能。項目A3) ====
function getYukiStationNoticeRecipients_(config) {
  const all = getPersonNotifyRecipients_(config, 'YUKI'); // [本人, 一志(CC), きくみ(CC)]
  return getYukiStationNoticeCc_() ? all : [all[0]];
}

// ==== 「迎えの連絡+帰りの雨雲アラート」のメッセージ文面 ====
function buildYukiStationNoticeMessage_(label, endTime, rainSpotDetails) {
  const endLabel = Utilities.formatDate(endTime, 'Asia/Tokyo', 'H:mm');
  const lines = [];
  lines.push('【ゆうき】' + label + ' 帰り 雨雲通過予報・迎えの連絡リマインド');
  lines.push('帰りの予定(' + endLabel + '頃)にかけての雨雲の様子:');
  if (rainSpotDetails.length === 0) {
    lines.push('雨雲情報を取得できませんでした。');
  } else {
    rainSpotDetails.forEach(function (spot) {
      lines.push('・' + spot.label + ': ' + spot.mmh + 'mm/h');
    });
  }
  lines.push(label + 'は' + endLabel + 'ごろ終了予定です。刈谷市駅で乗る電車が決まったら、迎えの担当の方へ若林駅の到着時刻を連絡してください。' +
    '学校を出てから若林駅までは、' + getYukiStationArrivalMinMin_() + '〜' + getYukiStationArrivalMaxMin_() + '分ほどかかる見込みです。');
  const sourceLine = buildSourceLinksLine_(false, rainSpotDetails.length > 0);
  if (sourceLine) lines.push(sourceLine);
  // 河川水位リンクは送信の共通経路(sendLinePushMessage_)が付与するため、ここでは付けない(項目A1)。
  return lines.join('\n');
}

/**
 * みつきさんの家庭発の習い事(お茶等、BIKEモード)の帰りの雨雲アラート(項目A6)
 * ------------------------------------------------------------
 * 既存の「帰りの雨雲アラート」(scheduleHomewardRainAlertFor_)は、英語・お茶をMITSUKI_LESSON_NAMES_で
 * 除外している(いったん帰宅してから家庭発で出発する予定のため、学校発の帰り予定時刻の算出対象には
 * 含めない設計。上記参照)。そのため従来、お茶自体の帰り(お茶の終了時刻を基準にした)雨雲アラートは
 * 存在しなかった。この関数はその欠落を埋め、お茶の終了時刻のHOMEWARD_ALERT_LEAD_MIN分前(既存の
 * 帰りの雨雲アラートと同じ既定30分)に、既存の「みつきの下校時雨雲アラート」と同じ宛先で通知する。
 * 対象地点は自宅のみ(項目A1で確定・ユーザー承認済み。お茶の教室は自宅周辺のため前林中学校は
 * 含めない。下校時雨雲アラート側は登校日・部活の帰りが対象のため、引き続き自宅+前林中学校のまま
 * 変更していない)。英語(車で迎え、CARモード)は対象外(現状維持。車送迎のため)。
 * 対象はBIKEモードかつMITSUKI_LESSON_NAMES_に一致する予定(現状は「お茶」のみ該当。英語はCARモードの
 * ため自動的に対象外)。お茶自体の場所(location)が取れる場合にその地点を雨雲判定に使う設計は、
 * 今回は見送った(調査結果は報告参照。getMaxForecastRainfallMmh_はWEATHER_LOCATIONS_の固定キーのみ
 * 対応しており、任意住所のジオコーディング・ナウキャスト判定には別途対応が必要なため)。
 * ------------------------------------------------------------
 */
const MITSUKI_LESSON_RAIN_ALERT_PENDING_PREFIX_ = 'PENDING_MITSUKI_LESSON_RAIN_ALERT_';

// ==== 確定版配信時に、みつきさんの家庭発の習い事(お茶等)の帰りの雨雲アラートを予約する ====
function scheduleMitsukiLessonRainAlerts_(targetDate, calendarId, mitsukiSections) {
  const leadMin = getWeatherConfig_().homewardAlertLeadMin;
  const targets = (mitsukiSections || []).filter(function (r) { return r.mode === 'BIKE' && isMitsukiLessonName_(r.label); });
  if (targets.length === 0) return;

  targets.forEach(function (target, index) {
    if (!target.endTime) {
      Logger.log('みつき: ' + target.label + 'は終了時刻が不明なため、帰りの雨雲アラートは予約しませんでした。');
      return;
    }
    const alertTime = new Date(target.endTime.getTime() - leadMin * 60 * 1000);
    if (alertTime.getTime() <= Date.now()) {
      Logger.log('みつき: ' + target.label + '(終了予定 ' + target.endTime + ')が近すぎる/過去のため、帰りの雨雲アラートは予約しませんでした。');
      return;
    }

    const props = PropertiesService.getScriptProperties();
    const key = MITSUKI_LESSON_RAIN_ALERT_PENDING_PREFIX_ + Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyyMMdd') + '_' + index;
    props.setProperty(key, JSON.stringify({
      label: target.label,
      endTime: target.endTime.toISOString(),
      scheduledAt: alertTime.toISOString(),
    }));
    ScriptApp.newTrigger('runScheduledMitsukiLessonRainAlerts_').timeBased().at(alertTime).create();
    Logger.log('みつき: ' + target.label + 'の帰りの雨雲アラートを' + alertTime + 'に予約しました(終了予定 ' + target.endTime + ')。');
  });
}

// ==== 予約されたみつきさんの習い事帰りの雨雲アラートを、実際の時刻が来たら送信する(使い捨てトリガーから呼ばれる) ====
function runScheduledMitsukiLessonRainAlerts_(e) {
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
    if (key.indexOf(MITSUKI_LESSON_RAIN_ALERT_PENDING_PREFIX_) !== 0) return;
    const data = JSON.parse(allProps[key]);
    if (new Date(data.scheduledAt).getTime() > now + 60 * 1000) return;

    props.deleteProperty(key); // 二重送信防止のため、処理対象として取り出した時点で先に削除

    try {
      const rainSpotDetails = [];
      // 項目A1(今回): 対象は自宅のみ(ユーザー承認済み)。お茶の教室は自宅周辺のため、
      // 前林中学校を含める必要が無く、お茶自身の場所(location)を使う実装も不要と判断した。
      ['HOME'].forEach(function (locKey) {
        const mmh = getMaxForecastRainfallMmh_(locKey);
        if (mmh !== null) rainSpotDetails.push({ label: WEATHER_LOCATIONS_[locKey].label, mmh: mmh });
      });
      // 既存の「みつきの下校時雨雲アラート」と同じ文面構成を使う(項目A6)。どの予定の帰りかを
      // 明示するため、personLabelに予定名を併記する(下校時雨雲アラートと同時に届いても区別できるように)。
      const message = buildHomewardRainAlertMessage_('みつき(' + data.label + ')', new Date(data.endTime), rainSpotDetails, false);
      sendLinePushToRecipients_(getPersonNotifyRecipients_(config, 'MITSUKI'), message);
    } catch (err) {
      Logger.log('みつきの習い事帰りの雨雲アラートの送信でエラー(' + data.label + '): ' + err.message);
    }
  });
}

/**
 * 直前アラート(項目A-2・項目A5)
 * ------------------------------------------------------------
 * 出発まわりの通知(項目A)でCARモード(英語)またはTRANSITモード(ゆうきの非登校日部活)と
 * 判定された予定について、家を出る目安(target.departureTime)のCAR_PICKUP_ALERT_LEAD_MIN分前
 * (デフォルト60分・Config.gs)に発火する使い捨てトリガーを予約する。
 * 項目A5: 以前はCARモードの予定開始時刻(startTime)を基準にしていたが、「家を出る目安の60分前」
 * という仕様に合わせ、departureTimeを基準にするよう修正した(CARモードのdepartureTimeは
 * startTime − CAR_TRAVEL_MINUTES_DEFAULTのため、この修正により実際のアラート時刻がわずかに早まる)。
 * 帰りの雨雲アラート(scheduleHomewardRainAlerts_)と同じ、スクリプトプロパティ+
 * 使い捨てトリガーによる予約パターンを踏襲している。送迎の手配は本人の責任という方針のため、
 * 内容は「連絡リマインド」に徹し、自転車換算・降水判定は行わない。
 * ------------------------------------------------------------
 */
const CAR_PICKUP_ALERT_PENDING_PREFIX_ = 'PENDING_CAR_PICKUP_ALERT_';

// ==== 確定版配信時に、出発まわりの通知でCAR/TRANSITモードだった予定それぞれの直前アラートを予約する ====
function scheduleCarPickupAlerts_(targetDate, calendarId, departureNoticesByPerson) {
  const leadMin = getCarPickupAlertLeadMin_();
  const nowMs = Date.now(); // 「本当に過去かどうか」の判定にのみ使う(実際の現在時刻)
  // 項目A3: 抑制判定(下記)の基準は実行時刻ではなく、対象日の「確定版配信時刻」の名目値(6:30、仮値)に
  // する。手動テストの実行時刻に関わらず、本番と同じ判定になるようにするための変更。本番の動作
  // (確定版の実行中に直前アラート等を予約する、という処理の流れ自体)は変更していない。
  const finalNoticeMs = getFinalNoticeTimeFor_(targetDate).getTime();

  ['YUKI', 'MITSUKI'].forEach(function (personKey) {
    const personLabel = personKey === 'YUKI' ? 'ゆうき' : 'みつき';
    const targets = (departureNoticesByPerson[personKey] || []).filter(function (r) { return r.mode === 'CAR' || r.mode === 'TRANSIT'; });
    if (targets.length === 0) return;

    targets.forEach(function (target, index) {
      const alertTime = new Date(target.departureTime.getTime() - leadMin * 60 * 1000);
      if (alertTime.getTime() <= nowMs) {
        Logger.log(personLabel + ': ' + target.label + '(家を出る目安 ' + target.departureTime + ')が近すぎる/過去のため、直前アラートは予約しませんでした。');
        return;
      }
      // 項目A5(項目A3で基準を変更): 直前アラートの予約時刻が、確定版配信時刻(名目6:30、仮値)の
      // 前後60分(仮値)以内なら出さない(確定版本文で既に同じ内容が案内済みのため、直後に
      // 「直前」アラートが重ねて届くのを避ける)。
      const suppressMin = getCarPickupAlertSuppressNearFinalMin_();
      if ((alertTime.getTime() - finalNoticeMs) / (60 * 1000) <= suppressMin) {
        Logger.log(personLabel + ': ' + target.label + 'の直前アラート予定時刻(' + alertTime + ')が確定版配信時刻(名目)から' +
          suppressMin + '分以内のため、予約しませんでした(項目A5)。');
        return;
      }

      const props = PropertiesService.getScriptProperties();
      const key = CAR_PICKUP_ALERT_PENDING_PREFIX_ + personKey + '_' + Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyyMMdd') + '_' + index;
      props.setProperty(key, JSON.stringify({
        personKey: personKey,
        personLabel: personLabel,
        label: target.label,
        mode: target.mode,
        startTime: target.startTime.toISOString(),
        departureTime: target.departureTime.toISOString(),
        pickupTime: target.pickupTime ? target.pickupTime.toISOString() : null,
        scheduledAt: alertTime.toISOString(),
      }));
      ScriptApp.newTrigger('runScheduledCarPickupAlerts_').timeBased().at(alertTime).create();
      Logger.log(personLabel + ': ' + target.label + 'の直前アラートを' + alertTime + 'に予約しました(家を出る目安 ' + target.departureTime + ')。');
    });
  });
}

// ==== 予約された直前アラートを、実際の時刻が来たら送信する(使い捨てトリガーから呼ばれる) ====
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
      const message = buildCarPickupAlertMessage_(data.personLabel, data.label, data.mode || 'CAR',
        new Date(data.startTime), new Date(data.departureTime), data.pickupTime ? new Date(data.pickupTime) : null);
      sendLinePushToRecipients_(getPersonNotifyRecipients_(config, data.personKey), message);
    } catch (err) {
      Logger.log('直前アラートの送信でエラー(' + data.label + '): ' + err.message);
    }
  });
}

// ==== 直前アラートのメッセージ文面(CAR/TRANSITで文面が異なる) ====
function buildCarPickupAlertMessage_(personLabel, label, mode, startTime, departureTime, pickupTime) {
  const departureLabel = Utilities.formatDate(departureTime, 'Asia/Tokyo', 'H:mm');
  const lines = [];
  lines.push('【' + personLabel + '】' + label + ' 出発まわりの通知(直前)');
  if (mode === 'TRANSIT') {
    lines.push('まもなく' + departureLabel + 'ごろ家を出る目安です(' + label + ')。若林駅へ(車)。車送迎の担当の方に連絡リマインドしてください。');
    return lines.join('\n');
  }
  const startLabel = Utilities.formatDate(startTime, 'Asia/Tokyo', 'H:mm');
  lines.push('まもなく' + startLabel + 'から' + label + 'です。車送迎の担当の方に連絡リマインドしてください。');
  if (pickupTime) {
    lines.push('帰りのお迎え目安: ' + Utilities.formatDate(pickupTime, 'Asia/Tokyo', 'H:mm') + '頃');
  }
  return lines.join('\n');
}

/**
 * 迎えの連絡リマインド(項目A2・項目A5)
 * ------------------------------------------------------------
 * 出発まわりの通知(項目A)でCARモード(英語)またはTRANSITモード(ゆうきの非登校日部活)と
 * 判定された予定について、終了時刻を基準に「迎えの担当の方に連絡リマインドしてください」を送る。
 * ・CARモード: 終了時刻のPICKUP_REMINDER_LEAD_MIN_CAR分前(デフォルト30分・仮値)。雨雲情報は付けない。
 * ・TRANSITモード: 終了時刻ちょうど(0分前)。駅に着く時刻が分かってから連絡する運用のため、
 *   終了時刻より前ではなく終了時刻そのものを基準にする(ユーザー指示A2)。
 * 直前アラート(scheduleCarPickupAlerts_)と同じ、スクリプトプロパティ+使い捨てトリガーの
 * 予約パターンを踏襲している。
 * ------------------------------------------------------------
 */
const PICKUP_REMINDER_PENDING_PREFIX_ = 'PENDING_PICKUP_REMINDER_';

// ==== 確定版配信時に、出発まわりの通知でCAR/TRANSITモードだった予定それぞれの迎えの連絡リマインドを予約する ====
function schedulePickupReminders_(targetDate, calendarId, departureNoticesByPerson) {
  // 項目A3: ゆうきさんのTRANSITモードは「迎えの連絡+帰りの雨雲アラート」(scheduleYukiStationNotices_)に
  // 統合したため、ここではCARモード(現状はみつきさんの英語のみ)だけを対象とする。
  ['YUKI', 'MITSUKI'].forEach(function (personKey) {
    const personLabel = personKey === 'YUKI' ? 'ゆうき' : 'みつき';
    const targets = (departureNoticesByPerson[personKey] || []).filter(function (r) { return r.mode === 'CAR'; });
    if (targets.length === 0) return;

    targets.forEach(function (target, index) {
      if (!target.endTime) {
        Logger.log(personLabel + ': ' + target.label + 'は終了時刻が不明なため、迎えの連絡リマインドは予約しませんでした。');
        return;
      }
      const leadMin = getPickupReminderLeadMinCar_();
      const reminderTime = new Date(target.endTime.getTime() - leadMin * 60 * 1000);
      if (reminderTime.getTime() <= Date.now()) {
        Logger.log(personLabel + ': ' + target.label + '(終了予定 ' + target.endTime + ')が近すぎる/過去のため、迎えの連絡リマインドは予約しませんでした。');
        return;
      }

      const props = PropertiesService.getScriptProperties();
      const key = PICKUP_REMINDER_PENDING_PREFIX_ + personKey + '_' + Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyyMMdd') + '_' + index;
      props.setProperty(key, JSON.stringify({
        personKey: personKey,
        personLabel: personLabel,
        label: target.label,
        mode: target.mode,
        endTime: target.endTime.toISOString(),
        scheduledAt: reminderTime.toISOString(),
      }));
      ScriptApp.newTrigger('runScheduledPickupReminders_').timeBased().at(reminderTime).create();
      Logger.log(personLabel + ': ' + target.label + 'の迎えの連絡リマインドを' + reminderTime + 'に予約しました(終了予定 ' + target.endTime + ')。');
    });
  });
}

// ==== 予約された迎えの連絡リマインドを、実際の時刻が来たら送信する(使い捨てトリガーから呼ばれる) ====
function runScheduledPickupReminders_(e) {
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
    if (key.indexOf(PICKUP_REMINDER_PENDING_PREFIX_) !== 0) return;
    const data = JSON.parse(allProps[key]);
    if (new Date(data.scheduledAt).getTime() > now + 60 * 1000) return;

    props.deleteProperty(key); // 二重送信防止のため、処理対象として取り出した時点で先に削除

    try {
      const message = buildPickupReminderMessage_(data.label, new Date(data.endTime));
      // 項目A4: みつきさんの英語(CARモード)の迎えの連絡リマインドは、みつき本人には送らず
      // 一志さん・きくみさんのみに送る(お迎えの手配を確認するのは親の役割のため)。
      const recipients = data.personKey === 'MITSUKI'
        ? getPersonNotifyRecipients_(config, 'MITSUKI').slice(1) // 本人(先頭)を除く
        : getPersonNotifyRecipients_(config, data.personKey);
      sendLinePushToRecipients_(recipients, message);
    } catch (err) {
      Logger.log('迎えの連絡リマインドの送信でエラー(' + data.label + '): ' + err.message);
    }
  });
}

// ==== 迎えの連絡リマインドのメッセージ文面(天気情報は付けない。項目A4で文言を変更) ====
function buildPickupReminderMessage_(label, endTime) {
  const endLabel = Utilities.formatDate(endTime, 'Asia/Tokyo', 'H:mm');
  const lines = [];
  lines.push('【みつき】' + label + ' 迎えの連絡リマインド');
  lines.push(label + 'は' + endLabel + 'ごろ終了予定です。お迎えの手配を確認してください。');
  return lines.join('\n');
}

/**
 * 自転車の出発直前アラート(項目9)
 * ------------------------------------------------------------
 * 出発まわりの通知(項目A)でBIKEモードと判定された予定(お茶・部活等)について、
 * 出発目安のBIKE_DEPARTURE_ALERT_LEAD_MIN分前(デフォルト30分・Config.gs、仮値)に発火する
 * 使い捨てトリガーを予約する。車送迎の直前アラートと異なり、宛先は本人のみ(親へのCCは付けない)。
 * 内容は自転車での出発を促す簡潔なリマインドで、雨天時はカッパの携行を案内する。
 * ------------------------------------------------------------
 */
const BIKE_DEPARTURE_ALERT_PENDING_PREFIX_ = 'PENDING_BIKE_DEPARTURE_ALERT_';

// ==== 確定版配信時に、出発まわりの通知でBIKEモードだった予定それぞれの出発直前アラートを予約する ====
function scheduleBikeDepartureAlerts_(targetDate, calendarId, departureNoticesByPerson) {
  const leadMin = getBikeDepartureAlertLeadMin_();
  const nowMs = Date.now(); // 「本当に過去かどうか」の判定にのみ使う(実際の現在時刻)
  // 項目A3: 抑制判定(下記)の基準は実行時刻ではなく、対象日の「確定版配信時刻」の名目値(6:30、仮値)にする。
  const finalNoticeMs = getFinalNoticeTimeFor_(targetDate).getTime();

  ['YUKI', 'MITSUKI'].forEach(function (personKey) {
    const personLabel = personKey === 'YUKI' ? 'ゆうき' : 'みつき';
    const bikeTargets = (departureNoticesByPerson[personKey] || []).filter(function (r) { return r.mode === 'BIKE'; });
    if (bikeTargets.length === 0) return;

    bikeTargets.forEach(function (target, index) {
      const alertTime = new Date(target.departureTime.getTime() - leadMin * 60 * 1000);
      if (alertTime.getTime() <= nowMs) {
        Logger.log(personLabel + ': ' + target.label + '(出発目安 ' + target.departureTime + ')が近すぎる/過去のため、自転車の出発直前アラートは予約しませんでした。');
        return;
      }
      // 項目A5(項目A3で基準を変更): 直前アラートと同じ抑制ルール(確定版配信時刻(名目、仮値)の
      // 前後60分・仮値以内なら出さない)
      const suppressMin = getCarPickupAlertSuppressNearFinalMin_();
      if ((alertTime.getTime() - finalNoticeMs) / (60 * 1000) <= suppressMin) {
        Logger.log(personLabel + ': ' + target.label + 'の自転車の出発直前アラート予定時刻(' + alertTime + ')が確定版配信時刻(名目)から' +
          suppressMin + '分以内のため、予約しませんでした(項目A5)。');
        return;
      }

      const props = PropertiesService.getScriptProperties();
      const key = BIKE_DEPARTURE_ALERT_PENDING_PREFIX_ + personKey + '_' + Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyyMMdd') + '_' + index;
      props.setProperty(key, JSON.stringify({
        personKey: personKey,
        personLabel: personLabel,
        label: target.label,
        departureTime: target.departureTime.toISOString(),
        isRaining: target.isRaining,
        scheduledAt: alertTime.toISOString(),
      }));
      ScriptApp.newTrigger('runScheduledBikeDepartureAlerts_').timeBased().at(alertTime).create();
      Logger.log(personLabel + ': ' + target.label + 'の自転車出発直前アラートを' + alertTime + 'に予約しました(出発目安 ' + target.departureTime + ')。');
    });
  });
}

// ==== 予約された自転車の出発直前アラートを、実際の時刻が来たら送信する(使い捨てトリガーから呼ばれる) ====
function runScheduledBikeDepartureAlerts_(e) {
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
    if (key.indexOf(BIKE_DEPARTURE_ALERT_PENDING_PREFIX_) !== 0) return;
    const data = JSON.parse(allProps[key]);
    if (new Date(data.scheduledAt).getTime() > now + 60 * 1000) return;

    props.deleteProperty(key); // 二重送信防止のため、処理対象として取り出した時点で先に削除

    try {
      const message = buildBikeDepartureAlertMessage_(data.personLabel, data.label, new Date(data.departureTime), data.isRaining);
      // 親へのCCは付けない(項目9)。本人の宛先・チャネルは、その時点のconfigからpersonKeyで解決する
      // (getPersonNotifyRecipients_の1件目=本人枠を使う。userId未登録時はsendLinePushMessage_内でスキップされる)。
      const self = getPersonNotifyRecipients_(config, data.personKey)[0];
      sendLinePushMessage_(self.userId, message, self.accessToken, self.channelLabel);
    } catch (err) {
      Logger.log('自転車の出発直前アラートの送信でエラー(' + data.label + '): ' + err.message);
    }
  });
}

// ==== 自転車の出発直前アラートのメッセージ文面(本人のみ宛) ====
function buildBikeDepartureAlertMessage_(personLabel, label, departureTime, isRaining) {
  const departureLabel = Utilities.formatDate(departureTime, 'Asia/Tokyo', 'H:mm');
  const lines = [];
  lines.push('【' + personLabel + '】' + label + ' 出発まわりの通知(直前)');
  lines.push('まもなく' + departureLabel + 'に家を出る時間です(' + label + ')。自転車で出発してください。');
  if (isRaining) {
    lines.push('雨天のためカッパを持って行ってください。');
  }
  return lines.join('\n');
}

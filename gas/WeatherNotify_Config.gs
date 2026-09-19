/**
 * 天気×カレンダー通知機能 - 設定
 * ------------------------------------------------------------
 * 既存の「家族スケジュール自動登録.gs」に追加する機能です。
 * このファイルは地点情報・しきい値など、運用しながら調整する値をまとめています。
 *
 * ■ 追加で必要なスクリプトプロパティ
 *   LINE_CHANNEL_ACCESS_TOKEN … 「崎家エージェント」(検証・デバッグ用)チャネルのアクセストークン(長期)
 *   LINE_CHANNEL_SECRET       … 同チャネルのChannel secret(Webhook署名検証用。現状は未使用。将来の署名検証実装に備えて保持)
 *   LINE_CHANNEL_ACCESS_TOKEN_YUKI / LINE_CHANNEL_SECRET_YUKI / LINE_WEBHOOK_TOKEN_YUKI
 *   LINE_CHANNEL_ACCESS_TOKEN_MITSUKI / LINE_CHANNEL_SECRET_MITSUKI / LINE_WEBHOOK_TOKEN_MITSUKI
 *   LINE_CHANNEL_ACCESS_TOKEN_KAZUSHI / LINE_CHANNEL_SECRET_KAZUSHI / LINE_WEBHOOK_TOKEN_KAZUSHI
 *   LINE_CHANNEL_ACCESS_TOKEN_KIKUMI / LINE_CHANNEL_SECRET_KIKUMI / LINE_WEBHOOK_TOKEN_KIKUMI
 *                              … 月200通の無料メッセージ枠がチャネル単位のため、配信先ごとに分けた
 *                                4つの専用チャネル(崎家エージェント＠ゆうき用/みつき用/一志用/きくみ用)の
 *                                認証情報。SECRETは現状未使用(検証用チャネルと同様)。詳細はWeatherNotify_Line.gs参照。
 *   YAHOO_APP_ID              … Yahoo!デベロッパーネットワークで発行するアプリケーションID(YOLP用)
 *
 * ■ 任意のスクリプトプロパティ(未設定なら下記デフォルト値を使用。運用しながら調整可能)
 *   WEATHER_DRY_RUN                    … "true"ならLINE送信せずログ出力のみ(本番反映前のテスト用。デフォルトtrue)
 *   LINE_USER_ID_YUKI / LINE_USER_ID_MITSUKI
 *                                      … 友だち追加時にWebhookで自動登録されるが、手動で設定してもよい
 *   LINE_USER_ID_KAZUSHI / LINE_USER_ID_KIKUMI
 *                                      … 一志さん・きくみさんのuserId(CC受信用)。未取得の間は空欄のままでよく、
 *                                        値を設定するだけで配信対象に加わる(コード変更不要)。
 *                                        ゆうきさん向け・みつきさん向け、それぞれの通知が同一内容で2通届く。
 *   YUKI_POP_THRESHOLD                 … バス推奨とする降水確率(%)のしきい値(デフォルト50)
 *   YUKI_RAIN_INTENSITY_THRESHOLD_MMH  … バス推奨とする雨雲の降水強度しきい値(mm/h、デフォルト1)
 *   MITSUKI_RAIN_BUFFER_MIN            … 雨天時に追加する移動バッファ(分、デフォルト10)
 *   MITSUKI_DEFAULT_TRAVEL_MIN         … 自転車移動時間が取得できない場合のフォールバック値(分、デフォルト15)
 *   YUKI_DEFAULT_SCHOOL_END            … ゆうきさんの通常下校時刻(部活が無い日の下校時刻。デフォルト17:00)
 *   MITSUKI_DEFAULT_SCHOOL_END         … みつきさんの通常下校時刻(部活が無い日の下校時刻。デフォルト16:00)
 *   HOMEWARD_ALERT_LEAD_MIN            … 「帰りの雨雲通過予報」を帰り予定時刻の何分前に送るか(デフォルト30)
 *   CAR_PICKUP_ALERT_LEAD_MIN          … 車送迎の直前アラートを、予定開始の何分前に送るか(デフォルト60)
 *   BIKE_DEPARTURE_ALERT_LEAD_MIN      … 自転車の出発直前アラート(本人のみ)を、出発目安の何分前に送るか(デフォルト30、仮値)
 *   ARRIVAL_MARGIN_MIN                 … 出発目安の計算に加える「到着の余裕」(分、デフォルト0)
 *   CAR_TRAVEL_MINUTES_DEFAULT         … 車送迎(CARモード)の出発目安を計算する際の移動時間の仮値(分、デフォルト10)
 *   CAR_EVENT_DEFAULT_DURATION_MIN     … 車送迎の予定に終了時刻が無い場合の所要時間の仮値(分、デフォルト90)
 * ------------------------------------------------------------
 */

// ==== 天気情報の出典URL(全メッセージ共通。判定に実際に使ったデータ種別に応じて付記する) ====
const WEATHER_SOURCE_URL_POP_ = 'https://www.jma.go.jp/bosai/forecast/#area_type=offices&area_code=230000';
const WEATHER_SOURCE_URL_NOWCAST_ = 'https://weather.yahoo.co.jp/weather/zoomradar/';

// ==== 地点情報(住所ベース。実行時にジオコーディングして緯度経度に変換しキャッシュする) ====
const WEATHER_LOCATIONS_ = {
  HOME: { key: 'HOME', label: '自宅', address: '愛知県豊田市堤町平松' },
  SCHOOL_YUKI: { key: 'SCHOOL_YUKI', label: '刈谷高校', address: '愛知県刈谷市寿町5-101 愛知県立刈谷高等学校' },
  SCHOOL_MITSUKI: { key: 'SCHOOL_MITSUKI', label: '前林中学校', address: '愛知県豊田市前林町行田60 豊田市立前林中学校' },
  // 中継地点はゆうきさんの登校判定(バス/自転車)にのみ使用
  STATION_WAKABAYASHI: { key: 'STATION_WAKABAYASHI', label: '名鉄若林駅', address: '愛知県豊田市若林東町 名鉄三河線 若林駅' },
  STATION_CHIRYU: { key: 'STATION_CHIRYU', label: '知立駅', address: '愛知県知立市 知立駅' },
  STATION_KARIYASHI: { key: 'STATION_KARIYASHI', label: '刈谷市駅', address: '愛知県刈谷市 名鉄三河線 刈谷市駅' },
};

// ゆうきさんの登校経路上、雨雲判定の対象にする地点(自宅・学校・中継地点)
const YUKI_ROUTE_CHECK_KEYS_ = [
  'HOME',
  'SCHOOL_YUKI',
  'STATION_WAKABAYASHI',
  'STATION_CHIRYU',
  'STATION_KARIYASHI',
];

// ==== 設定値の読み込み(数値・フラグ系のみ。既存のgetConfig_とは独立させ、既存ファイルへの影響を避ける) ====
function getWeatherConfig_() {
  const props = PropertiesService.getScriptProperties();
  const numOr = function (value, fallback) {
    const n = Number(value);
    return value && !isNaN(n) ? n : fallback;
  };
  return {
    // 検証・デバッグ用(既存の「崎家エージェント」チャネル)。手動テスト時のフォールバック先。
    lineChannelAccessToken: props.getProperty('LINE_CHANNEL_ACCESS_TOKEN') || '',
    lineChannelSecret: props.getProperty('LINE_CHANNEL_SECRET') || '',
    // 配信先ごとに分けた専用チャネル(月200通の無料枠をチャネル単位で分散させるため)
    lineChannelAccessTokenYuki: props.getProperty('LINE_CHANNEL_ACCESS_TOKEN_YUKI') || '',
    lineChannelAccessTokenMitsuki: props.getProperty('LINE_CHANNEL_ACCESS_TOKEN_MITSUKI') || '',
    lineChannelAccessTokenKazushi: props.getProperty('LINE_CHANNEL_ACCESS_TOKEN_KAZUSHI') || '',
    lineChannelAccessTokenKikumi: props.getProperty('LINE_CHANNEL_ACCESS_TOKEN_KIKUMI') || '',
    yahooAppId: props.getProperty('YAHOO_APP_ID') || '',
    dryRun: (props.getProperty('WEATHER_DRY_RUN') || 'true') === 'true',
    lineUserIdYuki: props.getProperty('LINE_USER_ID_YUKI') || '',
    lineUserIdMitsuki: props.getProperty('LINE_USER_ID_MITSUKI') || '',
    lineUserIdKazushi: props.getProperty('LINE_USER_ID_KAZUSHI') || '',
    lineUserIdKikumi: props.getProperty('LINE_USER_ID_KIKUMI') || '',
    popThreshold: numOr(props.getProperty('YUKI_POP_THRESHOLD'), 50),
    rainIntensityThresholdMmh: numOr(props.getProperty('YUKI_RAIN_INTENSITY_THRESHOLD_MMH'), 1),
    mitsukiRainBufferMin: numOr(props.getProperty('MITSUKI_RAIN_BUFFER_MIN'), 10),
    mitsukiDefaultTravelMin: numOr(props.getProperty('MITSUKI_DEFAULT_TRAVEL_MIN'), 15),
    homewardAlertLeadMin: numOr(props.getProperty('HOMEWARD_ALERT_LEAD_MIN'), 30),
  };
}

// ==== 家族カレンダー上で「学校が休みと分かる」予定に含まれるキーワード(登校日判定用) ====
// 【ゆうき】/【みつき】タグの予定にこれらのキーワードを含む終日予定がある日は登校日としない。
// 定期試験・文化祭などは登校日のままにするため、ここには含めない。運用しながら調整可能。
const NON_SCHOOL_DAY_KEYWORDS_ = [
  '夏休み', '冬休み', '春休み', '休校', '学校閉庁日', '創立記念日', '振替休日',
];

// ==== 国民の祝日の判定元(Googleが公開している「日本の祝日」カレンダー) ====
// 取得に失敗した場合(権限エラー・一時的な障害等)のみ、家族スケジュール自動登録.gsの
// JAPAN_HOLIDAYS_(内閣府公表の静的リスト、2026年4月〜2027年3月分)にフォールバックする。
// フォールバックが発生したことは1回の実行につき1回だけ警告ログに出す(japanHolidayFallbackWarned_)。
const JAPAN_HOLIDAY_CALENDAR_ID_ = 'ja.japanese#holiday@group.v.calendar.google.com';
let japanHolidayFallbackWarned_ = false;

// ==== 対象日の祝日名を取得(祝日でなければnull)。Googleの祝日カレンダーを優先し、失敗時のみ静的リストを使う ====
function getJapanHolidayName_(dateStr, verbose) {
  try {
    const calendar = CalendarApp.getCalendarById(JAPAN_HOLIDAY_CALENDAR_ID_);
    const date = new Date(dateStr + 'T00:00:00');
    const events = calendar.getEventsForDay(date);
    if (verbose) {
      Logger.log('[isSchoolDay_診断] Googleの祝日カレンダー照会結果: ' +
        (events.length > 0 ? events.map(function (ev) { return ev.getTitle(); }).join('、') : '(該当イベントなし)'));
    }
    return events.length > 0 ? events[0].getTitle() : null;
  } catch (e) {
    if (!japanHolidayFallbackWarned_) {
      Logger.log('Googleの祝日カレンダー(' + JAPAN_HOLIDAY_CALENDAR_ID_ + ')の取得に失敗したため、' +
        '静的リスト(家族スケジュール自動登録.gsのJAPAN_HOLIDAYS_)にフォールバックします: ' + e.message);
      japanHolidayFallbackWarned_ = true;
    }
    const holidayMap = buildHolidayNameMap_(); // 既存スクリプト(家族スケジュール自動登録.gs)の関数を再利用(フォールバック専用)
    return holidayMap[dateStr] || null;
  }
}

// ==== 対象日が指定した家族(namePrefix: '【ゆうき】' or '【みつき】')の登校日か判定 ====
// 平日 かつ 国民の祝日でない かつ カレンダー上に長期休み等を示す終日予定が無いこと、を条件とする。
// verbose=trueを渡すと、どの条件で除外されたか(該当した場合はイベントのタイトルも)をログに出す診断モード。
function isSchoolDay_(date, calendarId, namePrefix, verbose) {
  const dateStr = Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd');
  const dow = date.getDay();
  if (verbose) {
    Logger.log('[isSchoolDay_診断] ' + namePrefix + ' 対象日=' + dateStr + ' dow=' + dow + '(0=日〜6=土) ISO=' + date.toISOString());
  }
  if (dow === 0 || dow === 6) {
    if (verbose) Logger.log('[isSchoolDay_診断] → 土日のため登校日ではないと判定');
    return false; // 土日
  }

  const holidayName = getJapanHolidayName_(dateStr, verbose);
  if (holidayName) {
    if (verbose) Logger.log('[isSchoolDay_診断] → 国民の祝日(' + holidayName + ')のため登校日ではないと判定');
    return false; // 国民の祝日
  }

  try {
    const calendar = CalendarApp.getCalendarById(calendarId);
    const dayStart = new Date(dateStr + 'T00:00:00');
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const events = calendar.getEvents(dayStart, dayEnd);
    if (verbose) {
      Logger.log('[isSchoolDay_診断] 検索範囲: ' + dayStart.toISOString() + ' 〜 ' + dayEnd.toISOString() +
        ' / ' + namePrefix + 'に一致する予定: ' +
        events.filter(function (ev) { return ev.getTitle().indexOf(namePrefix) === 0; })
          .map(function (ev) {
            return '"' + ev.getTitle() + '"(終日:' + ev.isAllDayEvent() +
              ', 開始:' + ev.getStartTime().toISOString() + ', 終了:' + ev.getEndTime().toISOString() + ')';
          }).join(' / ') || '(該当する予定なし)');
    }
    const matchedEvent = events.find(function (ev) {
      const title = ev.getTitle();
      if (title.indexOf(namePrefix) !== 0) return false;
      return NON_SCHOOL_DAY_KEYWORDS_.some(function (kw) {
        return title.indexOf(kw) !== -1;
      });
    });
    if (matchedEvent) {
      if (verbose) Logger.log('[isSchoolDay_診断] → 休み系キーワードに一致する予定「' + matchedEvent.getTitle() + '」があるため登校日ではないと判定');
      return false;
    }
  } catch (e) {
    Logger.log('登校日判定中のカレンダー確認でエラー(判定は続行): ' + e.message);
  }

  if (verbose) Logger.log('[isSchoolDay_診断] → 除外条件に該当せず、登校日と判定');
  return true;
}

/**
 * 降水確率・雨雲通過予報(地点ごとの降水強度)から「雨天と判断すべきか」を判定する共通の純粋関数。
 * ゆうきさんのバス/自転車判定・みつきさんの送迎判定など、複数の判定で共用する
 * (ネットワークアクセスを行わないため、テストハーネスからモックデータで検証できる)。
 * @param {number|null} pop 降水確率(%)。取得できなかった場合はnull
 * @param {Array<{label:string, mmh:number}>} rainSpotDetails 地点ごとの降水強度予測(mm/h)。
 *   ナウキャストを確認していない場合は空配列を渡す(「雨雲なし」と断定しないため)。
 * @param {Object} config getWeatherConfig_()の戻り値(popThreshold, rainIntensityThresholdMmhを使用)
 * @return {Object} { rainy: boolean, reasons: string[], pop: number|null, usedPop: boolean, usedNowcast: boolean }
 */
function evaluateRainCondition_(pop, rainSpotDetails, config) {
  const reasons = [];
  let rainy = false;

  if (pop !== null) {
    if (pop >= config.popThreshold) {
      rainy = true;
      reasons.push('降水確率' + pop + '%(しきい値' + config.popThreshold + '%以上)');
    } else {
      reasons.push('降水確率' + pop + '%(しきい値' + config.popThreshold + '%未満)');
    }
  } else {
    reasons.push('降水確率を取得できませんでした');
  }

  const overThresholdSpots = rainSpotDetails.filter(function (spot) { return spot.mmh >= config.rainIntensityThresholdMmh; });
  if (overThresholdSpots.length > 0) {
    rainy = true;
    const rainSpots = overThresholdSpots.map(function (spot) { return spot.label + '(' + spot.mmh + 'mm/h)'; });
    reasons.push('今後の雨雲通過予報: ' + rainSpots.join('、'));
  } else if (rainSpotDetails.length > 0) {
    // ナウキャストを実際に確認した(=rainSpotDetailsが空でない)がしきい値以上の地点が無かった場合のみ明記する。
    reasons.push('雨雲通過予報なし');
  }

  return {
    rainy: rainy,
    reasons: reasons,
    pop: pop,
    usedPop: pop !== null,
    usedNowcast: rainSpotDetails.length > 0,
  };
}

/**
 * 対象日の「学校(または活動場所)から家に向かって出発する時刻」を、ゆうき・みつき共通で算出する。
 * ルール:
 *   1. 対象日に時刻付きの【namePrefix】予定(部活動等、学校発の予定)があれば、最も遅く終わる予定の
 *      終了時刻を採用する。ただし次のいずれかに該当する予定は候補から除外する。
 *      (a) 予定名がexcludeLabelKeywordsのいずれかを含む(英語・お茶のような、いったん家に帰ってから
 *          改めて家庭から出発する予定。「学校から家に向かう時刻」の計算には含めない)。
 *      (b) その予定の移動手段(getEventTransportMode_)が'CAR'(車送迎固定)である(例: ゆうきの非登校日の
 *          部活は項目8により車送迎固定になったため、自転車ルートの雨雲予報である「帰りの雨雲アラート」の
 *          基準には使わない。車で送迎される日は、その情報自体が意味を持たないため)。
 *      これらを除外しないと、実際の帰り時刻より大幅に遅い(または無関係な)時刻が「帰り予定」として
 *      算出されてしまい、帰りの雨雲アラートの発火予約が大きくずれるバグになる(過去に発生した実例)。
 *   2. 該当する予定が1件も無い場合のみ、対象日が登校日であればdefaultTimeStr(通常の下校時刻)を採用する。
 *      (予定があるのに既定時刻と比較して遅い方を採る、という処理は行わない。部活が既定時刻より早く
 *      終わる日は、その部活の終了時刻をそのまま採用する)
 *   3. 予定も無く、登校日でもない場合はnullを返す。
 * @param {Date} targetDate 対象日
 * @param {string} calendarId 家族共有カレンダーのID
 * @param {string} namePrefix '【ゆうき】' または '【みつき】'
 * @param {string} defaultTimeStr 通常下校時刻(例: '17:00')
 * @param {string[]} [excludeLabelKeywords] この文字列のいずれかを予定名に含む場合、候補から除外する(部分一致)
 * @param {string} [personKey] 'YUKI'または'MITSUKI'。CARモード判定(getEventTransportMode_)に使う
 * @return {{time: Date, source: 'calendar'|'default', label: string}|null}
 */
function getHomewardDepartureTime_(targetDate, calendarId, namePrefix, defaultTimeStr, excludeLabelKeywords, personKey) {
  const dateStr = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  const dayStart = new Date(dateStr + 'T00:00:00');
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const isSchool = isSchoolDay_(targetDate, calendarId, namePrefix);

  let latestEventEnd = null;
  let latestEventLabel = null;
  try {
    const calendar = CalendarApp.getCalendarById(calendarId);
    const events = calendar.getEvents(dayStart, dayEnd);
    events.forEach(function (ev) {
      if (ev.getTitle().indexOf(namePrefix) !== 0 || ev.isAllDayEvent()) return;
      const label = ev.getTitle().replace(namePrefix, '');
      if (excludeLabelKeywords && excludeLabelKeywords.some(function (kw) { return label.indexOf(kw) !== -1; })) return;
      if (personKey && getEventTransportMode_(label, personKey, isSchool) === 'CAR') return;
      const end = ev.getEndTime();
      if (!latestEventEnd || end > latestEventEnd) {
        latestEventEnd = end;
        latestEventLabel = label;
      }
    });
  } catch (e) {
    Logger.log('下校時刻算出中のカレンダー確認でエラー: ' + e.message);
  }

  if (latestEventEnd) {
    return { time: latestEventEnd, source: 'calendar', label: latestEventLabel };
  }

  if (isSchool) {
    return { time: new Date(dateStr + 'T' + defaultTimeStr + ':00'), source: 'default', label: '通常下校' };
  }
  return null; // 登校日でもなく、時刻付きの予定も無い日
}

/**
 * 予定名(キーワード部分一致)→移動手段の対応表(項目A-2)。
 * 一致しなければ既定は'BIKE'(自転車)。ただし、ゆうきさんの非登校日の予定は既定を'CAR'に切り替える
 * (項目8: 実態として土日祝・長期休暇の部活はほぼ常に車送迎のため)。'CAR'は自転車換算・降水判定・
 * カッパ準備・送迎要否判断を一切行わず、常に車での送迎を前提とした「連絡リマインド」型の文面になる
 * (buildDepartureNoticeMessage_参照)。「英語(塾)」のように括弧書きが付く場合があるため部分一致で判定する。
 * @param {string} label 予定名(【ゆうき】等のタグを除いた部分)
 * @param {string} [personKey] 'YUKI'または'MITSUKI'
 * @param {boolean} [isSchoolDayFlag] 対象日が登校日かどうか
 */
const EVENT_TRANSPORT_MODE_KEYWORDS_ = {
  '英語': 'CAR',
};

function getEventTransportMode_(label, personKey, isSchoolDayFlag) {
  const keys = Object.keys(EVENT_TRANSPORT_MODE_KEYWORDS_);
  for (let i = 0; i < keys.length; i++) {
    if (label.indexOf(keys[i]) !== -1) return EVENT_TRANSPORT_MODE_KEYWORDS_[keys[i]];
  }
  if (personKey === 'YUKI' && !isSchoolDayFlag) return 'CAR';
  return 'BIKE';
}

// ==== 車送迎の直前アラート(連絡リマインド。本人+CC)を、予定開始の何分前に送るか(項目A-2) ====
const CAR_PICKUP_ALERT_LEAD_MIN_PROP_ = 'CAR_PICKUP_ALERT_LEAD_MIN';
const CAR_PICKUP_ALERT_LEAD_MIN_FALLBACK_ = 60;

function getCarPickupAlertLeadMin_() {
  const value = PropertiesService.getScriptProperties().getProperty(CAR_PICKUP_ALERT_LEAD_MIN_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : CAR_PICKUP_ALERT_LEAD_MIN_FALLBACK_;
}

// ==== 自転車の出発直前アラート(本人のみ、CCなし)を、出発目安の何分前に送るか(項目9・仮値) ====
const BIKE_DEPARTURE_ALERT_LEAD_MIN_PROP_ = 'BIKE_DEPARTURE_ALERT_LEAD_MIN';
const BIKE_DEPARTURE_ALERT_LEAD_MIN_FALLBACK_ = 30;

function getBikeDepartureAlertLeadMin_() {
  const value = PropertiesService.getScriptProperties().getProperty(BIKE_DEPARTURE_ALERT_LEAD_MIN_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : BIKE_DEPARTURE_ALERT_LEAD_MIN_FALLBACK_;
}

// ==== 到着の余裕(自転車の出発目安の計算に加える。項目2。初期値0=余裕を見ない) ====
const ARRIVAL_MARGIN_MIN_PROP_ = 'ARRIVAL_MARGIN_MIN';
const ARRIVAL_MARGIN_MIN_FALLBACK_ = 0;

function getArrivalMarginMin_() {
  const value = PropertiesService.getScriptProperties().getProperty(ARRIVAL_MARGIN_MIN_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : ARRIVAL_MARGIN_MIN_FALLBACK_;
}

// ==== 車送迎(CARモード)の出発目安・お迎え目安を計算する際の仮値(項目1) ====
// 車の移動時間は自転車のようにMapsで計算せず、固定の仮値を使う(送迎の手配・所要時間は送迎担当者に委ねる方針のため)。
const CAR_TRAVEL_MINUTES_DEFAULT_PROP_ = 'CAR_TRAVEL_MINUTES_DEFAULT';
const CAR_TRAVEL_MINUTES_DEFAULT_FALLBACK_ = 10;

function getCarTravelMinutesDefault_() {
  const value = PropertiesService.getScriptProperties().getProperty(CAR_TRAVEL_MINUTES_DEFAULT_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : CAR_TRAVEL_MINUTES_DEFAULT_FALLBACK_;
}

// 予定に終了時刻が無い場合(通常のGoogleカレンダー予定では起こらないが念のため)の所要時間の仮値
const CAR_EVENT_DEFAULT_DURATION_MIN_PROP_ = 'CAR_EVENT_DEFAULT_DURATION_MIN';
const CAR_EVENT_DEFAULT_DURATION_MIN_FALLBACK_ = 90;

function getCarEventDefaultDurationMin_() {
  const value = PropertiesService.getScriptProperties().getProperty(CAR_EVENT_DEFAULT_DURATION_MIN_PROP_);
  const n = Number(value);
  return value && !isNaN(n) ? n : CAR_EVENT_DEFAULT_DURATION_MIN_FALLBACK_;
}

/**
 * 「出発まわりの通知」(項目A)の対象予定一覧を、ゆうき・みつき共通で取得する。
 * 対象:
 *   - 非登校日(土日祝・長期休暇等): その日の時刻付き【namePrefix】予定すべて
 *     (部活・習い事の区別なく、学校を経由しない「家からの予定」として扱う)
 *   - 登校日: householdLessonKeywordsに一致する予定のみ(英語・お茶等、家から向かう習い事)。
 *     部活のように学校で完結する予定は対象外(登校自体の通知は別関数で扱う。項目B/C参照)。
 * @param {Date} targetDate 対象日
 * @param {string} calendarId 家族共有カレンダーのID
 * @param {string} namePrefix '【ゆうき】' または '【みつき】'
 * @param {boolean} isSchoolDayFlag 対象日が登校日かどうか(isSchoolDay_の結果をそのまま渡す)
 * @param {string[]} householdLessonKeywords 登校日に対象とする、家から向かう習い事名のキーワード一覧(部分一致)
 * @param {string} defaultDestinationAddress 予定にlocationが無い場合の目的地(通常は学校の住所)
 * @param {string} personKey 'YUKI'または'MITSUKI'(移動手段の判定に使う。getEventTransportMode_参照)
 * @return {Array<{label:string, startTime:Date, endTime:Date, destinationAddress:string, mode:'CAR'|'BIKE'}>}
 */
function getDepartureNoticeTargets_(targetDate, calendarId, namePrefix, isSchoolDayFlag, householdLessonKeywords, defaultDestinationAddress, personKey) {
  const dateStr = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  const dayStart = new Date(dateStr + 'T00:00:00');
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const calendar = CalendarApp.getCalendarById(calendarId);
  const events = calendar.getEvents(dayStart, dayEnd);
  const timedEvents = events.filter(function (ev) {
    return ev.getTitle().indexOf(namePrefix) === 0 && !ev.isAllDayEvent();
  });
  timedEvents.sort(function (a, b) { return a.getStartTime() - b.getStartTime(); });

  const isHouseholdLesson = function (label) {
    return householdLessonKeywords.some(function (kw) { return label.indexOf(kw) !== -1; });
  };

  const targets = [];
  timedEvents.forEach(function (ev) {
    const label = ev.getTitle().replace(namePrefix, '');
    const included = isSchoolDayFlag ? isHouseholdLesson(label) : true;
    Logger.log('[出発まわりの通知診断] ' + namePrefix + ' "' + label + '"(' +
      Utilities.formatDate(ev.getStartTime(), 'Asia/Tokyo', 'H:mm') + '〜): ' +
      (isSchoolDayFlag
        ? (included ? '登校日だが家庭発の習い事に該当するため対象' : '登校日かつ学校完結型の予定のため対象外')
        : '非登校日のため対象') );
    if (!included) return;
    targets.push({
      label: label,
      startTime: ev.getStartTime(),
      endTime: ev.getEndTime(),
      destinationAddress: ev.getLocation() || defaultDestinationAddress,
      mode: getEventTransportMode_(label, personKey, isSchoolDayFlag),
    });
  });
  return targets;
}

/**
 * 予定開始時刻・自転車移動時間・降水確率から出発時刻を算出する純粋関数(自転車移動共通部分)。
 * ネットワークアクセスを行わないため、テストハーネスからモックデータで検証できる。
 * みつきさんの登校(自転車通学、項目B)・出発まわりの通知(項目A・BIKEモード)の両方で使う。
 * 式(項目2): 出発目安 = 開始時刻 − 自転車の移動時間 − 雨天バッファ − 到着の余裕(ARRIVAL_MARGIN_MIN)。
 * 到着の余裕は初期値0分(みつきさんは開始ちょうどに着く実態のため)。
 */
function calcBikeDeparture_(startTime, travelMinutes, pop, config) {
  const isRaining = pop !== null && pop >= config.popThreshold;
  const bufferMin = isRaining ? config.mitsukiRainBufferMin : 0;
  const marginMin = getArrivalMarginMin_();
  const departureTime = new Date(startTime.getTime() - (travelMinutes + bufferMin + marginMin) * 60 * 1000);
  return {
    departureTime: departureTime,
    travelMinutes: travelMinutes,
    isRaining: isRaining,
    bufferMin: bufferMin,
    marginMin: marginMin,
    pop: pop,
    usedPop: pop !== null,
  };
}

/**
 * 出発まわりの通知(項目A)1件分の詳細を、気象データ・移動時間・送迎判定用の降水確率から算出する純粋関数。
 * ネットワークアクセスを行わないため、テストハーネスからモックデータで検証できる。
 * CARモード(項目A-2)はtravelMinutes/pop/returnPopを一切使わない(自転車換算・降水判定・
 * カッパ準備・送迎要否判断は行わない)。
 * @param {Object} target getDepartureNoticeTargets_の要素({label, startTime, mode, ...})
 * @param {number} travelMinutes 自転車移動時間(分。CARモードでは無視される)
 * @param {number|null} pop 予定開始時刻の降水確率(%。CARモードでは無視される)
 * @param {number|null} returnPop 帰り予定時刻の降水確率(%。CARモードでは無視される)
 * @param {{time:Date,source:string,label:string}|null} homeward その日の帰り予定(getHomewardDepartureTime_の結果)
 * @param {Object} config getWeatherConfig_()の戻り値
 */
function calcDepartureNoticeDetailsFromData_(target, travelMinutes, pop, returnPop, homeward, config) {
  if (target.mode === 'CAR') {
    // 行きの出発目安: 予定開始時刻から、車移動時間の仮値(CAR_TRAVEL_MINUTES_DEFAULT)を引いた時刻。
    // 帰りのお迎え目安: この予定「自身」の終了時刻を基準にする(その日全体の帰り予定=homewardは、
    // 英語・お茶等の家庭発の予定を除外して算出したものであり、この予定自体の終了時刻とは無関係のため、
    // homewardを流用すると誤った時刻になる。終了時刻が無い予定は開始+所要時間の仮値で代用する)。
    const carTravelMinutes = getCarTravelMinutesDefault_();
    const departureTime = new Date(target.startTime.getTime() - carTravelMinutes * 60 * 1000);
    const pickupTime = target.endTime || new Date(target.startTime.getTime() + getCarEventDefaultDurationMin_() * 60 * 1000);
    return {
      label: target.label,
      mode: 'CAR',
      startTime: target.startTime,
      departureTime: departureTime,
      travelMinutes: carTravelMinutes,
      pickupTime: pickupTime,
    };
  }

  const bike = calcBikeDeparture_(target.startTime, travelMinutes, pop, config);
  const go = evaluateRainCondition_(pop, [], config);
  const ret = evaluateRainCondition_(returnPop, [], config);
  const escortNeeded = go.rainy || ret.rainy;

  return {
    label: target.label,
    mode: 'BIKE',
    startTime: target.startTime,
    departureTime: bike.departureTime,
    travelMinutes: bike.travelMinutes,
    isRaining: bike.isRaining,
    bufferMin: bike.bufferMin,
    pop: bike.pop,
    usedPop: bike.usedPop,
    homewardTime: homeward ? homeward.time : null,
    escortNeeded: escortNeeded,
    go: go,
    ret: ret,
  };
}

/**
 * 出発まわりの通知(項目A)1件分の詳細を算出する(気象API・Mapsを実際に呼び出す)。
 * 実際のデータ取得を行い、純粋関数calcDepartureNoticeDetailsFromData_に渡すだけの薄いラッパー。
 * @param {Object} target getDepartureNoticeTargets_の要素
 * @param {string} homeAddress 自宅住所
 * @param {{time:Date,source:string,label:string}|null} homeward その日の帰り予定(getHomewardDepartureTime_の結果)
 * @param {Object} config getWeatherConfig_()の戻り値
 */
function calcDepartureNoticeDetails_(target, homeAddress, homeward, config) {
  if (target.mode === 'CAR') {
    return calcDepartureNoticeDetailsFromData_(target, null, null, null, homeward, config);
  }

  const travelMinutes = getBikingTravelMinutes_(homeAddress, target.destinationAddress);
  let pop = null;
  try {
    pop = getPrecipitationProbabilityAt_(target.startTime);
  } catch (e) {
    Logger.log('降水確率の取得でエラー(出発まわりの通知・' + target.label + '): ' + e.message);
  }
  let returnPop = null;
  if (homeward) {
    try {
      returnPop = getPrecipitationProbabilityAt_(homeward.time);
    } catch (e) {
      Logger.log('降水確率の取得でエラー(出発まわりの通知・帰り・' + target.label + '): ' + e.message);
    }
  }
  return calcDepartureNoticeDetailsFromData_(target, travelMinutes, pop, returnPop, homeward, config);
}

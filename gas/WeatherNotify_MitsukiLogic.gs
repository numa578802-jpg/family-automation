/**
 * みつきさん(前林中学校) 通学・出発まわりロジック
 * ------------------------------------------------------------
 * ・登校(自転車通学)の出発時刻お知らせ(項目B): 登校日のみ、朝の時刻付き予定(無ければ
 *   通常授業の登校時刻 MITSUKI_DEFAULT_SCHOOL_START にフォールバック)を基準に、自転車移動時間・
 *   降水確率から出発目安を算出する。送迎提案・徒歩提案は出さない。雨天時はカッパの準備を知らせる。
 * ・出発まわりの通知(項目A、ゆうき・みつき共通ロジックはConfig.gsのgetDepartureNoticeTargets_/
 *   calcDepartureNoticeDetails_): 非登校日はその日の時刻付き予定すべて、登校日は英語・お茶等
 *   「家から向かう習い事」(MITSUKI_LESSON_NAMES_)のみを対象に、1予定につき1件を生成する。
 *   部活のように学校で完結する予定は、登校日には対象外(下校後そのまま学校で参加するため)。
 * ・移動手段(自転車/車)はConfig.gsのEVENT_TRANSPORT_MODE_KEYWORDS_で予定名から判定する
 *   (英語=車固定。自転車換算・降水判定・カッパ準備・送迎要否判断は行わない)。
 * ------------------------------------------------------------
 */

// 通常授業日の標準登校時刻(確定値)
const MITSUKI_DEFAULT_SCHOOL_START_PROP_ = 'MITSUKI_DEFAULT_SCHOOL_START';
const MITSUKI_DEFAULT_SCHOOL_START_FALLBACK_ = '08:15';

function getMitsukiDefaultSchoolStart_() {
  return PropertiesService.getScriptProperties().getProperty(MITSUKI_DEFAULT_SCHOOL_START_PROP_) ||
    MITSUKI_DEFAULT_SCHOOL_START_FALLBACK_;
}

// 通常下校時刻(部活が無い日の下校時刻)
const MITSUKI_DEFAULT_SCHOOL_END_PROP_ = 'MITSUKI_DEFAULT_SCHOOL_END';
const MITSUKI_DEFAULT_SCHOOL_END_FALLBACK_ = '16:00';

function getMitsukiDefaultSchoolEnd_() {
  return PropertiesService.getScriptProperties().getProperty(MITSUKI_DEFAULT_SCHOOL_END_PROP_) ||
    MITSUKI_DEFAULT_SCHOOL_END_FALLBACK_;
}

// ==== 対象日がみつきさんの登校日かどうか判定(共通ロジックはConfig.gsのisSchoolDay_を使用) ====
function isMitsukiSchoolDay_(date, calendarId) {
  return isSchoolDay_(date, calendarId, '【みつき】');
}

// 家族プロフィールに登録されている「家から向かう習い事」の名前。この名称を含む予定は、
// 登校日でも「出発まわりの通知」(項目A)の対象になる(部活等の学校完結型の予定と違い、
// いったん帰宅してから改めて家から出発するため)。「英語(塾)」のように括弧書きが付く場合が
// あるため部分一致で判定する。
const MITSUKI_LESSON_NAMES_ = ['英語', 'お茶'];

function isMitsukiLessonName_(label) {
  return MITSUKI_LESSON_NAMES_.some(function (name) { return label.indexOf(name) !== -1; });
}

/**
 * みつきさんの「登校(自転車通学)」出発時刻お知らせ(項目B)の対象を取得する。
 * 登校日のみが対象。朝(正午より前)の時刻付き【みつき】予定があればそれを使い、無ければ
 * 通常授業の登校時刻(MITSUKI_DEFAULT_SCHOOL_START)にフォールバックする。非登校日はnullを返す
 * (非登校日の予定は項目Aの「出発まわりの通知」で扱う)。
 * @return {{label:string, startTime:Date, destinationAddress:string}|null}
 */
const MITSUKI_MORNING_CUTOFF_HOUR_ = 12; // この時刻より前に始まる予定を「朝の登校」とみなす上限

function getMitsukiSchoolCommuteTarget_(targetDate, calendarId) {
  if (!isMitsukiSchoolDay_(targetDate, calendarId)) return null;

  const dateStr = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  const dayStart = new Date(dateStr + 'T00:00:00');
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const morningCutoff = new Date(dateStr + 'T00:00:00');
  morningCutoff.setHours(MITSUKI_MORNING_CUTOFF_HOUR_, 0, 0, 0);

  const calendar = CalendarApp.getCalendarById(calendarId);
  const events = calendar.getEvents(dayStart, dayEnd);
  const morningEvents = events.filter(function (ev) {
    return ev.getTitle().indexOf('【みつき】') === 0 && !ev.isAllDayEvent() && ev.getStartTime() < morningCutoff;
  });
  morningEvents.sort(function (a, b) { return a.getStartTime() - b.getStartTime(); });

  if (morningEvents.length > 0) {
    const ev = morningEvents[0];
    return {
      label: ev.getTitle().replace('【みつき】', ''),
      startTime: ev.getStartTime(),
      destinationAddress: ev.getLocation() || WEATHER_LOCATIONS_.SCHOOL_MITSUKI.address,
    };
  }
  return {
    label: '登校(通常授業)',
    startTime: new Date(dateStr + 'T' + getMitsukiDefaultSchoolStart_() + ':00'),
    destinationAddress: WEATHER_LOCATIONS_.SCHOOL_MITSUKI.address,
  };
}

/**
 * みつきさんの登校(自転車通学)の出発時刻お知らせを算出する(気象API・Mapsを実際に呼び出す)。
 * 送迎要否・徒歩提案は判定しない(buildMitsukiSchoolCommuteMessage_側でも参照しない)。
 * @return {Object|null} 対象日が登校日でなければnull。
 */
function decideMitsukiSchoolCommute_(targetDate, calendarId) {
  const target = getMitsukiSchoolCommuteTarget_(targetDate, calendarId);
  if (!target) return null;

  const config = getWeatherConfig_();
  const travelMinutes = getBikingTravelMinutes_(WEATHER_LOCATIONS_.HOME.address, target.destinationAddress);
  let pop = null;
  try {
    pop = getPrecipitationProbabilityAt_(target.startTime);
  } catch (e) {
    Logger.log('降水確率の取得でエラー(みつき登校): ' + e.message);
  }
  const bike = calcBikeDeparture_(target.startTime, travelMinutes, pop, config);

  return {
    label: target.label,
    startTime: target.startTime,
    departureTime: bike.departureTime,
    travelMinutes: bike.travelMinutes,
    isRaining: bike.isRaining,
    bufferMin: bike.bufferMin,
    pop: bike.pop,
    usedPop: bike.usedPop,
  };
}

/**
 * みつきさんの「出発まわりの通知」(項目A)対象を算出する(気象API・Mapsを実際に呼び出す)。
 * @return {Array<Object>} calcDepartureNoticeDetails_の戻り値の配列。対象予定が無い日は空配列。
 */
function decideMitsukiDepartureNotices_(targetDate, calendarId) {
  const isSchool = isMitsukiSchoolDay_(targetDate, calendarId);
  const targets = getDepartureNoticeTargets_(targetDate, calendarId, '【みつき】', isSchool,
    MITSUKI_LESSON_NAMES_, WEATHER_LOCATIONS_.SCHOOL_MITSUKI.address);
  if (targets.length === 0) return [];

  const config = getWeatherConfig_();
  // 英語・お茶自体は「学校から家に向かう予定」ではない(いったん帰宅してから家庭発で出発する)ため、
  // 帰り予定時刻の算出対象からは除外する(MITSUKI_LESSON_NAMES_)。
  const homeward = getHomewardDepartureTime_(targetDate, calendarId, '【みつき】', getMitsukiDefaultSchoolEnd_(), MITSUKI_LESSON_NAMES_);
  return targets.map(function (target) {
    return calcDepartureNoticeDetails_(target, WEATHER_LOCATIONS_.HOME.address, homeward, config);
  });
}

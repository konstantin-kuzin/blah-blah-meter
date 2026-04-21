(function () {
  "use strict";

  var STORAGE_KEY = "startTracker.settings.v1";
  var THEME_STORAGE_KEY = "startTracker.theme.v1";
  var SALARY_COEFFICIENT = 1.5;
  var MONTHLY_WORK_HOURS = 160;
  var MINUTES_PER_MONTH = MONTHLY_WORK_HOURS * 60;
  var MAX_PER_GRADE = 99;
  var RUB_UPDATE_MS = 250;
  var KOP_UPDATE_MS = 62.5;
  var gradeIdSequence = 0;

  var DEFAULT_TITLE = "Наша щедрая компания заплатит за эту встречу";
  var DEFAULT_GRADES = [
    { id: "grade-1", name: "Designer", salary: 300000 },
    { id: "grade-2", name: "Team Lead", salary: 450000 },
    { id: "grade-3", name: "Group Manager", salary: 600000 },
    { id: "grade-4", name: "Head", salary: 750000 }
  ];

  var settings = loadSettings();
  var counts = createCountsMap(settings.grades);
  var meetingStartWallMs = null;
  var rubTimerId = null;
  var kopTimerId = null;
  var rounds = [];
  var roundsUnlocked = false;

  var initialTheme = loadThemePreference();
  document.documentElement.setAttribute("data-theme", initialTheme);

  var elAppTitle = document.getElementById("app-title");
  var elTotalCost = document.getElementById("total-cost");
  var elTotalRub = document.getElementById("total-rub");
  var elTotalKop = document.getElementById("total-kop");
  var elPerMinute = document.getElementById("per-minute-cost");
  var elPerMinuteRow = document.getElementById("per-minute-row");
  var elElapsedRow = document.getElementById("elapsed-row");
  var elElapsed = document.getElementById("elapsed-display");
  var elRoundsSection = document.getElementById("rounds-section");
  var elRoundsTrack = document.getElementById("rounds-track");
  var elRoundAddBtn = document.getElementById("round-add-btn");
  var elRoundAddValue = document.getElementById("round-add-value");
  var elGrades = document.getElementById("grades-list");
  var elStartTrigger = document.getElementById("start-time-trigger");
  var elStartPopover = document.getElementById("start-time-popover");
  var elStartTimeInput = document.getElementById("start-time-input");
  var elStartSave = document.getElementById("start-time-save");
  var elSettingsModal = document.getElementById("settings-modal");
  var elSettingsTrigger = document.getElementById("settings-trigger");
  var elSettingsClose = document.getElementById("settings-close");
  var elSettingsCancel = document.getElementById("settings-cancel");
  var elSettingsForm = document.getElementById("settings-form");
  var elSettingsTitleInput = document.getElementById("settings-title-input");
  var elSettingsGrades = document.getElementById("settings-grades");
  var elAddGradeBtn = document.getElementById("add-grade-btn");
  var elThemeToggle = document.getElementById("theme-toggle");
  var elThemeIcon = elThemeToggle.querySelector('[data-role="theme-icon"]');

  function loadThemePreference() {
    var storedTheme;

    try {
      storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    } catch (error) {
      storedTheme = null;
    }

    if (storedTheme === "light" || storedTheme === "dark") {
      return storedTheme;
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme(theme) {
    var nextTheme = theme === "dark" ? "dark" : "light";
    var nextLabel =
      nextTheme === "dark" ? "Включить светлую тему" : "Включить тёмную тему";

    document.documentElement.setAttribute("data-theme", nextTheme);
    elThemeToggle.setAttribute("aria-label", nextLabel);
    elThemeToggle.setAttribute("title", nextLabel);
    elThemeIcon.textContent = nextTheme === "dark" ? "☀" : "☾";

    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch (error) {
      return;
    }
  }

  function cloneDefaultGrades() {
    return DEFAULT_GRADES.map(function (grade) {
      return {
        id: grade.id,
        name: grade.name,
        salary: grade.salary
      };
    });
  }

  function nextGradeId() {
    gradeIdSequence += 1;
    return "grade-" + Date.now() + "-" + gradeIdSequence;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function toNonNegativeInteger(value) {
    var numeric = Number(value);
    if (!isFinite(numeric) || numeric < 0) return 0;
    return Math.round(numeric);
  }

  function normalizeGrade(rawGrade, index, seenIds) {
    var rawId = rawGrade && typeof rawGrade.id === "string" ? rawGrade.id.trim() : "";
    var id = rawId || nextGradeId();

    while (seenIds[id]) {
      id = nextGradeId();
    }

    seenIds[id] = true;

    var rawName = rawGrade && typeof rawGrade.name === "string" ? rawGrade.name.trim() : "";

    return {
      id: id,
      name: rawName || "Грейд " + String(index + 1),
      salary: toNonNegativeInteger(rawGrade && rawGrade.salary)
    };
  }

  function normalizeSpeech(rawSpeech) {
    var s = rawSpeech && typeof rawSpeech === "object" ? rawSpeech : {};
    var mode = s.mode === "groq" ? "groq" : "browser";
    var groqPostProcess = Boolean(s.groqPostProcess);
    var groqClientKey =
      typeof s.groqClientKey === "string" ? s.groqClientKey : "";
    var sttModel =
      s.sttModel === "whisper-large-v3" ? "whisper-large-v3" : "whisper-large-v3-turbo";
    var chatModel =
      typeof s.chatModel === "string" && s.chatModel.trim()
        ? s.chatModel.trim()
        : "llama-3.1-8b-instant";
    var translateEnabled = Boolean(s.translateEnabled);
    var translateTarget = s.translateTarget === "zh" ? "zh" : "en";

    return {
      mode: mode,
      groqPostProcess: groqPostProcess,
      groqClientKey: groqClientKey,
      sttModel: sttModel,
      chatModel: chatModel,
      translateEnabled: translateEnabled,
      translateTarget: translateTarget
    };
  }

  function normalizeSettings(rawSettings) {
    var source = rawSettings && typeof rawSettings === "object" ? rawSettings : {};
    var title =
      typeof source.title === "string" && source.title.trim()
        ? source.title.trim()
        : DEFAULT_TITLE;
    var gradesSource = Array.isArray(source.grades)
      ? source.grades
      : cloneDefaultGrades();
    var seenIds = Object.create(null);
    var grades = gradesSource.map(function (grade, index) {
      return normalizeGrade(grade, index, seenIds);
    });

    return {
      title: title,
      grades: grades,
      speech: normalizeSpeech(source.speech)
    };
  }

  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return normalizeSettings(null);
      return normalizeSettings(JSON.parse(raw));
    } catch (error) {
      return normalizeSettings(null);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      return;
    }
  }

  function createCountsMap(grades, previousCounts) {
    var nextCounts = Object.create(null);

    grades.forEach(function (grade) {
      var prev = previousCounts && previousCounts[grade.id];
      nextCounts[grade.id] = Math.max(0, Math.min(MAX_PER_GRADE, Number(prev) || 0));
    });

    return nextCounts;
  }

  function getSortedGrades() {
    return settings.grades.slice().sort(function (left, right) {
      if (left.salary !== right.salary) return left.salary - right.salary;
      return left.name.localeCompare(right.name, "ru");
    });
  }

  function totalParticipants() {
    return Object.keys(counts).reduce(function (sum, gradeId) {
      return sum + counts[gradeId];
    }, 0);
  }

  function costPerMinuteRub() {
    return settings.grades.reduce(function (sum, grade) {
      var ratePerMinute = (grade.salary * SALARY_COEFFICIENT) / MINUTES_PER_MONTH;
      return sum + counts[grade.id] * ratePerMinute;
    }, 0);
  }

  function formatIntegerPlain(number) {
    var value = Math.trunc(number);
    return (value < 0 ? "-" : "") + String(Math.abs(value));
  }

  function formatRubInteger(rubles) {
    return formatIntegerPlain(rubles);
  }

  function formatMoney(value) {
    var totalKop = Math.round(Number(value) * 100);
    var rub = Math.floor(totalKop / 100);
    var kop = totalKop % 100;
    return formatIntegerPlain(rub) + "," + String(kop).padStart(2, "0");
  }

  function elapsedSinceStartMs() {
    if (meetingStartWallMs == null) return 0;
    return Math.max(0, Date.now() - meetingStartWallMs);
  }

  function resetRounds() {
    rounds = [];
    roundsUnlocked = false;
  }

  function ensureInitialRound() {
    if (meetingStartWallMs == null || rounds.length > 0) return;

    rounds.push({
      startMs: meetingStartWallMs,
      endMs: null
    });
  }

  function activeRound() {
    if (rounds.length === 0) return null;
    return rounds[rounds.length - 1];
  }

  function roundElapsedMs(round, nowMs) {
    if (!round) return 0;

    var endMs = round.endMs == null ? nowMs : round.endMs;
    return Math.max(0, endMs - round.startMs);
  }

  function roundCostRubles(round, nowMs) {
    return costPerMinuteRub() * (roundElapsedMs(round, nowMs) / 60000);
  }

  function renderRounds() {
    var nowMs = Date.now();
    var visibleRounds = roundsUnlocked
      ? rounds.filter(function (round) {
          return round.endMs != null;
        })
      : [];

    elRoundsTrack.innerHTML = visibleRounds
      .map(function (round) {
        return (
          '<article class="rounds__card">' +
          '<span class="rounds__time">' +
          formatElapsed(roundElapsedMs(round, nowMs)) +
          "</span>" +
          '<span class="rounds__money">' +
          formatMoney(roundCostRubles(round, nowMs)) +
          " руб." +
          "</span>" +
          "</article>"
        );
      })
      .join("");

    renderRoundButton(nowMs);
  }

  function renderRoundButton(nowMs) {
    var active = roundsUnlocked ? activeRound() : null;

    if (!active) {
      elRoundAddValue.textContent = "";
      return;
    }

    elRoundAddValue.textContent = formatMoney(roundCostRubles(active, nowMs || Date.now())) + " руб.";
  }

  function syncRoundsVisibility(participants) {
    var hasMeeting = participants > 0 && meetingStartWallMs != null;
    elRoundsSection.hidden = !hasMeeting;
    elRoundAddBtn.disabled = !hasMeeting;
  }

  function keepRoundButtonInView() {
    window.requestAnimationFrame(function () {
      elRoundAddBtn.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "end"
      });
    });
  }

  function startNextRound() {
    var nowMs = Date.now();
    var previousRound = activeRound();
    var startMs = meetingStartWallMs;

    if (meetingStartWallMs == null || totalParticipants() === 0) return;
    ensureInitialRound();
    previousRound = activeRound();

    if (previousRound) {
      previousRound.endMs = nowMs;
      startMs = nowMs;
    }

    rounds.push({
      startMs: startMs,
      endMs: null
    });

    roundsUnlocked = true;
    renderRounds();
    keepRoundButtonInView();
  }

  function currentMeetingCostRubles() {
    if (totalParticipants() === 0 || meetingStartWallMs == null) return 0;
    return costPerMinuteRub() * (elapsedSinceStartMs() / 60000);
  }

  function setAriaLabelFromRublesFloat(rublesFloat) {
    var totalKop = Math.round(rublesFloat * 100);
    var rub = Math.floor(totalKop / 100);
    var kop = totalKop % 100;

    elTotalCost.setAttribute(
      "aria-label",
      "Стоимость встречи " +
        formatRubInteger(rub) +
        " руб. " +
        String(kop).padStart(2, "0") +
        " коп."
    );
  }

  function setTotalDisplay(rublesFloat) {
    var totalKop = Math.round(rublesFloat * 100);
    var rub = Math.floor(totalKop / 100);
    var kop = totalKop % 100;

    elTotalRub.textContent = formatRubInteger(rub);
    elTotalKop.textContent = String(kop).padStart(2, "0");
    setAriaLabelFromRublesFloat(rublesFloat);
  }

  function applyRubAndElapsed() {
    var total = currentMeetingCostRubles();
    var totalKop = Math.round(total * 100);
    var rub = Math.floor(totalKop / 100);

    elTotalRub.textContent = formatRubInteger(rub);

    if (meetingStartWallMs != null) {
      elElapsed.textContent = formatElapsed(elapsedSinceStartMs());
    }

    if (rounds.length > 0) {
      renderRoundButton(Date.now());
    }
  }

  function applyKopOnly() {
    var total = currentMeetingCostRubles();
    var totalKop = Math.round(total * 100);
    var kop = totalKop % 100;

    elTotalKop.textContent = String(kop).padStart(2, "0");
    setAriaLabelFromRublesFloat(total);

    if (rounds.length > 0) {
      renderRoundButton(Date.now());
    }
  }

  function formatElapsed(ms) {
    var totalSec = Math.floor(ms / 1000);
    var minutes = Math.floor(totalSec / 60);
    var seconds = totalSec % 60;
    return (
      String(minutes).padStart(2, "0") +
      " мин. " +
      String(seconds).padStart(2, "0") +
      " сек."
    );
  }

  function stopCostTimers() {
    if (rubTimerId != null) {
      clearInterval(rubTimerId);
      rubTimerId = null;
    }

    if (kopTimerId != null) {
      clearInterval(kopTimerId);
      kopTimerId = null;
    }
  }

  function ensureCostTimers() {
    if (totalParticipants() <= 0 || meetingStartWallMs == null) return;
    if (rubTimerId != null) return;

    rubTimerId = setInterval(applyRubAndElapsed, RUB_UPDATE_MS);
    kopTimerId = setInterval(applyKopOnly, KOP_UPDATE_MS);
  }

  function renderGrades() {
    var gradeMarkup = getSortedGrades()
      .map(function (grade) {
        return (
          '<article class="grade-row" data-grade-id="' +
          escapeHtml(grade.id) +
          '">' +
          '<div class="grade-row__avatar grade-row__avatar--zero">' +
          '<span class="grade-row__avatar-num" data-role="count">0</span>' +
          "</div>" +
          '<div class="grade-row__meta">' +
          '<span class="grade-row__label">' +
          escapeHtml(grade.name) +
          "</span>" +
          "</div>" +
          '<div class="grade-row__actions">' +
          '<button type="button" class="btn btn--minus" data-action="dec" data-grade-id="' +
          escapeHtml(grade.id) +
          '" aria-label="Убрать участника грейда ' +
          escapeHtml(grade.name) +
          '">−</button>' +
          '<button type="button" class="btn btn--plus" data-action="inc" data-grade-id="' +
          escapeHtml(grade.id) +
          '" aria-label="Добавить участника грейда ' +
          escapeHtml(grade.name) +
          '">+</button>' +
          "</div>" +
          "</article>"
        );
      })
      .join("");

    elGrades.innerHTML = gradeMarkup;
  }

  function updateDom() {
    var participants = totalParticipants();
    var perMinute = costPerMinuteRub();

    Array.prototype.forEach.call(elGrades.querySelectorAll(".grade-row"), function (row) {
      var gradeId = row.getAttribute("data-grade-id");
      var count = counts[gradeId] || 0;
      var avatar = row.querySelector(".grade-row__avatar");
      var label = row.querySelector(".grade-row__label");
      var countNode = row.querySelector('[data-role="count"]');
      var minusBtn = row.querySelector(".btn--minus");
      var plusBtn = row.querySelector(".btn--plus");

      countNode.textContent = String(count);
      avatar.classList.toggle("grade-row__avatar--zero", count === 0);
      avatar.classList.toggle("grade-row__avatar--has", count > 0);
      label.classList.toggle("grade-row__label--zero", count === 0);
      minusBtn.disabled = count <= 0;
      plusBtn.disabled = count >= MAX_PER_GRADE;
    });

    if (participants === 0) {
      stopCostTimers();
      closeStartPopover();
      resetRounds();
      setTotalDisplay(0);
      elPerMinute.textContent = formatMoney(0);
      elPerMinuteRow.hidden = true;
      elElapsedRow.hidden = true;
      syncRoundsVisibility(participants);
      renderRounds();
      return;
    }

    elPerMinute.textContent = formatMoney(perMinute);
    elPerMinuteRow.hidden = false;
    elElapsedRow.hidden = false;
    ensureInitialRound();
    syncRoundsVisibility(participants);

    ensureCostTimers();
    applyRubAndElapsed();
    applyKopOnly();
  }

  function wallMsFromTimeInput(hours, minutes) {
    var now = new Date();
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hours,
      minutes,
      0,
      0
    ).getTime();
  }

  function fillTimeInputFromWallMs(wallMs) {
    var date = new Date(wallMs);
    var hours = String(date.getHours()).padStart(2, "0");
    var minutes = String(date.getMinutes()).padStart(2, "0");
    elStartTimeInput.value = hours + ":" + minutes;
  }

  function closeStartPopover() {
    elStartPopover.hidden = true;
    elStartTrigger.setAttribute("aria-expanded", "false");
  }

  function openStartPopover() {
    if (meetingStartWallMs == null) return;
    fillTimeInputFromWallMs(meetingStartWallMs);
    elStartPopover.hidden = false;
    elStartTrigger.setAttribute("aria-expanded", "true");
    elStartTimeInput.focus();
  }

  function saveStartTimeFromPopover() {
    var raw = elStartTimeInput.value;
    if (!raw) {
      closeStartPopover();
      return;
    }

    var parts = raw.split(":");
    var hours = parseInt(parts[0], 10);
    var minutes = parseInt(parts[1], 10);

    if (isNaN(hours) || isNaN(minutes)) return;

    meetingStartWallMs = wallMsFromTimeInput(hours, minutes);
    resetRounds();
    ensureInitialRound();
    closeStartPopover();
    renderRounds();
    applyRubAndElapsed();
    applyKopOnly();
  }

  function onCountsChanged(prevTotal) {
    var participants = totalParticipants();

    if (prevTotal === 0 && participants > 0) {
      meetingStartWallMs = Date.now();
      resetRounds();
      ensureInitialRound();
    } else if (participants === 0) {
      meetingStartWallMs = null;
      stopCostTimers();
      resetRounds();
    }

    updateDom();
  }

  function appendSettingsGradeRow(grade) {
    elSettingsGrades.insertAdjacentHTML("beforeend", buildSettingsGradeRowMarkup(grade, false));
  }

  function compareGradesBySalary(left, right) {
    var salaryDiff = toNonNegativeInteger(left.salary) - toNonNegativeInteger(right.salary);

    if (salaryDiff !== 0) return salaryDiff;

    return String(left.name || "").localeCompare(String(right.name || ""), "ru");
  }

  function buildSettingsGradeRowMarkup(grade, showLabels) {
    return (
      '<div class="settings-grade" data-grade-id="' +
      escapeHtml(grade.id) +
      '">' +
      '<label class="settings-grade__field">' +
      (showLabels ? '<span class="settings-form__label">Должность участника</span>' : "") +
      '<input class="settings-form__input settings-form__input--compact" type="text" name="grade-name" value="' +
      escapeHtml(grade.name) +
      '" placeholder="Например, Senior" required />' +
      "</label>" +
      '<label class="settings-grade__field">' +
      (showLabels ? '<span class="settings-form__label">Оклад, руб/мес</span>' : "") +
      '<input class="settings-form__input settings-form__input--compact" type="number" name="grade-salary" value="' +
      escapeHtml(String(grade.salary)) +
      '" min="0" placeholder="0" required />' +
      "</label>" +
      '<button type="button" class="settings-grade__delete" data-action="remove-grade" data-grade-id="' +
      escapeHtml(grade.id) +
      '" aria-label="Удалить ' +
      escapeHtml(grade.name || "") +
      '">' +
      '<span aria-hidden="true">✕</span>' +
      "</button>" +
      "</div>"
    );
  }

  function renderSettingsGradeRows(grades) {
    elSettingsGrades.innerHTML = grades
      .slice()
      .sort(compareGradesBySalary)
      .map(function (grade, index) {
        return buildSettingsGradeRowMarkup(grade, index === 0);
      })
      .join("");
  }

  function collectDraftGrades() {
    return Array.prototype.slice
      .call(elSettingsGrades.querySelectorAll(".settings-grade"))
      .map(function (row) {
        return {
          id: row.getAttribute("data-grade-id"),
          name: row.querySelector('[name="grade-name"]').value,
          salary: row.querySelector('[name="grade-salary"]').value
        };
      });
  }

  function updateSpeechSettingsFieldsVisibility() {
    var elModeGroq = document.getElementById("speech-mode-groq");
    var elGroqPost = document.getElementById("speech-groq-post");
    var elTranslateOn = document.getElementById("speech-translate-on");
    var elSttField = document.getElementById("speech-stt-model-field");
    var elChatField = document.getElementById("speech-chat-model-field");
    var elLangField = document.getElementById("speech-translate-lang-field");
    var groq = elModeGroq && elModeGroq.checked;
    var postOn = elGroqPost && elGroqPost.checked;
    var translateOn = elTranslateOn && elTranslateOn.checked;
    if (elSttField) elSttField.hidden = !groq;
    if (elChatField) elChatField.hidden = !postOn;
    if (elLangField) elLangField.hidden = !translateOn;
  }

  function populateSettingsForm() {
    var speech = settings.speech || normalizeSpeech(null);
    var elModeBrowser = document.getElementById("speech-mode-browser");
    var elModeGroq = document.getElementById("speech-mode-groq");
    var elGroqPost = document.getElementById("speech-groq-post");
    var elGroqKey = document.getElementById("speech-groq-key");
    var elStt = document.getElementById("speech-stt-model");
    var elChat = document.getElementById("speech-chat-model");
    var elTranslateOn = document.getElementById("speech-translate-on");
    var elTranslateLang = document.getElementById("speech-translate-lang");

    elSettingsTitleInput.value = settings.title;
    renderSettingsGradeRows(settings.grades);

    if (elModeBrowser && elModeGroq) {
      elModeGroq.checked = speech.mode === "groq";
      elModeBrowser.checked = speech.mode !== "groq";
    }
    if (elGroqPost) elGroqPost.checked = speech.groqPostProcess;
    if (elGroqKey) elGroqKey.value = speech.groqClientKey || "";
    if (elStt) elStt.value = speech.sttModel;
    if (elChat) elChat.value = speech.chatModel;
    if (elTranslateOn) elTranslateOn.checked = speech.translateEnabled;
    if (elTranslateLang) {
      elTranslateLang.value = speech.translateTarget === "zh" ? "zh" : "en";
    }
    updateSpeechSettingsFieldsVisibility();
  }

  function collectSettingsFromForm() {
    var elModeGroq = document.getElementById("speech-mode-groq");
    var elGroqPost = document.getElementById("speech-groq-post");
    var elGroqKey = document.getElementById("speech-groq-key");
    var elStt = document.getElementById("speech-stt-model");
    var elChat = document.getElementById("speech-chat-model");
    var elTranslateOn = document.getElementById("speech-translate-on");
    var elTranslateLang = document.getElementById("speech-translate-lang");
    var translateOn = elTranslateOn ? elTranslateOn.checked : false;
    var translateLang =
      elTranslateLang && elTranslateLang.value === "zh" ? "zh" : "en";

    return normalizeSettings({
      title: elSettingsTitleInput.value,
      grades: collectDraftGrades(),
      speech: {
        mode: elModeGroq && elModeGroq.checked ? "groq" : "browser",
        groqPostProcess: elGroqPost ? elGroqPost.checked : false,
        groqClientKey: elGroqKey ? elGroqKey.value : "",
        sttModel: elStt && elStt.value ? elStt.value : "whisper-large-v3-turbo",
        chatModel: elChat && elChat.value ? elChat.value : "llama-3.1-8b-instant",
        translateEnabled: translateOn,
        translateTarget: translateLang
      }
    });
  }

  function setSettingsTab(meetingActive) {
    var tabMeeting = document.getElementById("settings-tab-meeting");
    var tabSpeech = document.getElementById("settings-tab-speech");
    var panelMeeting = document.getElementById("settings-panel-meeting");
    var panelSpeech = document.getElementById("settings-panel-speech");
    if (!tabMeeting || !tabSpeech || !panelMeeting || !panelSpeech) return;
    tabMeeting.setAttribute("aria-selected", meetingActive ? "true" : "false");
    tabSpeech.setAttribute("aria-selected", meetingActive ? "false" : "true");
    tabMeeting.tabIndex = meetingActive ? 0 : -1;
    tabSpeech.tabIndex = meetingActive ? -1 : 0;
    tabMeeting.classList.toggle("settings-tabs__tab--active", meetingActive);
    tabSpeech.classList.toggle("settings-tabs__tab--active", !meetingActive);
    panelMeeting.hidden = !meetingActive;
    panelSpeech.hidden = meetingActive;
  }

  function openSettingsModal() {
    closeStartPopover();
    populateSettingsForm();
    setSettingsTab(true);
    elSettingsModal.hidden = false;
    document.body.classList.add("body--modal-open");
    elSettingsTitleInput.focus();
    elSettingsTitleInput.select();
  }

  function closeSettingsModal() {
    elSettingsModal.hidden = true;
    document.body.classList.remove("body--modal-open");
  }

  function applySettingsToView() {
    elAppTitle.textContent = settings.title;
    document.title = settings.title;
    renderGrades();
    updateDom();
  }

  elStartTrigger.addEventListener("click", function (event) {
    event.stopPropagation();

    if (elStartPopover.hidden) {
      openStartPopover();
      return;
    }

    closeStartPopover();
  });

  elStartSave.addEventListener("click", function () {
    saveStartTimeFromPopover();
  });

  elStartTimeInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      saveStartTimeFromPopover();
    }
  });

  elSettingsTrigger.addEventListener("click", function () {
    openSettingsModal();
  });

  (function initSettingsTabs() {
    var tabMeeting = document.getElementById("settings-tab-meeting");
    var tabSpeech = document.getElementById("settings-tab-speech");
    if (!tabMeeting || !tabSpeech) return;
    tabMeeting.addEventListener("click", function () {
      setSettingsTab(true);
    });
    tabSpeech.addEventListener("click", function () {
      setSettingsTab(false);
    });
  })();

  (function initSpeechTranslateControls() {
    var elOn = document.getElementById("speech-translate-on");
    if (!elOn) return;
    elOn.addEventListener("change", updateSpeechSettingsFieldsVisibility);
  })();

  (function initSpeechModelFieldsVisibility() {
    var elModeBrowser = document.getElementById("speech-mode-browser");
    var elModeGroq = document.getElementById("speech-mode-groq");
    var elGroqPost = document.getElementById("speech-groq-post");
    if (!elModeBrowser || !elModeGroq || !elGroqPost) return;
    elModeBrowser.addEventListener("change", updateSpeechSettingsFieldsVisibility);
    elModeGroq.addEventListener("change", updateSpeechSettingsFieldsVisibility);
    elGroqPost.addEventListener("change", updateSpeechSettingsFieldsVisibility);
  })();

  elThemeToggle.addEventListener("click", function () {
    var currentTheme = document.documentElement.getAttribute("data-theme");
    applyTheme(currentTheme === "dark" ? "light" : "dark");
  });

  elRoundAddBtn.addEventListener("click", function () {
    startNextRound();
  });

  elSettingsClose.addEventListener("click", function () {
    closeSettingsModal();
  });

  elSettingsCancel.addEventListener("click", function () {
    closeSettingsModal();
  });

  elAddGradeBtn.addEventListener("click", function () {
    var newGradeId = nextGradeId();
    var draftGrades = collectDraftGrades();
    draftGrades.push({
      id: newGradeId,
      name: "",
      salary: 0
    });
    renderSettingsGradeRows(draftGrades);

    var newRow = elSettingsGrades.querySelector(
      '.settings-grade[data-grade-id="' + newGradeId + '"]'
    );
    if (newRow) {
      var nameInput = newRow.querySelector('[name="grade-name"]');
      if (nameInput) nameInput.focus();
    }
  });

  elSettingsGrades.addEventListener("click", function (event) {
    var button = event.target.closest('button[data-action="remove-grade"]');
    var draftGrades;
    var nextRows;

    if (!button) return;

    draftGrades = collectDraftGrades().filter(function (grade) {
      return grade.id !== button.getAttribute("data-grade-id");
    });

    renderSettingsGradeRows(draftGrades);
    nextRows = elSettingsGrades.querySelectorAll(".settings-grade");

    if (nextRows.length > 0) {
      nextRows[Math.min(nextRows.length - 1, 0)]
        .querySelector('[name="grade-name"]')
        .focus();
    }
  });

  elSettingsForm.addEventListener("submit", function (event) {
    event.preventDefault();
    settings = collectSettingsFromForm();
    counts = createCountsMap(settings.grades, counts);
    saveSettings();
    applySettingsToView();
    if (window.startTrackerSpeech && window.startTrackerSpeech.configure) {
      window.startTrackerSpeech.configure(settings.speech);
    }
    closeSettingsModal();
  });

  elSettingsModal.addEventListener("click", function (event) {
    var target = event.target;
    if (target && target.getAttribute("data-modal-close") === "true") {
      closeSettingsModal();
    }
  });

  document.addEventListener("click", function (event) {
    if (!elStartPopover.hidden) {
      if (!elStartPopover.contains(event.target) && !elStartTrigger.contains(event.target)) {
        closeStartPopover();
      }
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;

    if (!elSettingsModal.hidden) {
      closeSettingsModal();
      return;
    }

    if (!elStartPopover.hidden) {
      closeStartPopover();
      return;
    }

    if (
      window.startTrackerSpeech &&
      window.startTrackerSpeech.handleDocumentEscape()
    ) {
      return;
    }
  });

  elGrades.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-action]");
    if (!button) return;

    var gradeId = button.getAttribute("data-grade-id");
    var action = button.getAttribute("data-action");
    var prevTotal = totalParticipants();

    if (action === "inc") {
      if (counts[gradeId] < MAX_PER_GRADE) counts[gradeId] += 1;
    } else if (action === "dec") {
      if (counts[gradeId] > 0) counts[gradeId] -= 1;
    }

    onCountsChanged(prevTotal);
  });

  applyTheme(initialTheme);
  applySettingsToView();
  if (window.startTrackerSpeech) {
    if (window.startTrackerSpeech.configure) {
      window.startTrackerSpeech.configure(settings.speech);
    }
    window.startTrackerSpeech.init();
  }
})();

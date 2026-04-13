(function (global) {
  "use strict";

  /** BCP 47: основной русский; встроенные англ. термины зависят от движка браузера. */
  var SPEECH_LANG = "ru-RU";
  /** Подсказка Whisper (language на сервере — ru): русская речь + англ. термины (до ~224 токенов). */
  var GROQ_TRANSCRIBE_PROMPT =
    "Русская устная речь; допускаются вставки на английском: термины, имена, аббревиатуры, названия API и фрагменты кода.";
  var SPEECH_RECOGNITION =
    typeof global !== "undefined"
      ? global.SpeechRecognition || global.webkitSpeechRecognition
      : null;

  var GROQ_API_PATH = "/api/groq";
  /* localStorage startTracker.speechDebug = "1" — подробные логи в консоли */
  function speechDebug() {
    try {
      return localStorage.getItem("startTracker.speechDebug") === "1";
    } catch (e) {
      return false;
    }
  }
  /* Крупнее кусок по времени; порог по байтам — не отсекать слишком много при низком битрейте Opus. */
  var GROQ_SLICE_MS = 6000;
  /* Минимальный размер blob (байт): только отсечь пустые; по доке Groq достаточно ≥0.01 с аудио. */
  var GROQ_MIN_CHUNK_BYTES = 256;
  var POLISH_DEBOUNCE_MS = 1400;
  /**
   * Дебаунс перевода: слишком короткий интервал даёт 429 (лимит RPM Groq).
   * Параллельные chat (постобработка + перевод) делят одну квоту.
   */
  var TRANSLATE_DEBOUNCE_MS = 1050;

  var speechRecognition = null;
  var speechWantListen = false;
  var speechFinalText = "";
  /** Последний перевод; при включённом переводе показывается вместо speechFinalText. */
  var translatedDisplayText = "";

  var speechConfig = {
    mode: "browser",
    groqPostProcess: false,
    groqClientKey: "",
    sttModel: "whisper-large-v3-turbo",
    chatModel: "llama-3.1-8b-instant",
    translateEnabled: false,
    translateTarget: "en"
  };

  var elTranscriptToggle = null;
  var elTranscriptScroll = null;
  var elTranscriptFinal = null;
  var elTranscriptInterim = null;

  var mediaStream = null;
  var mediaRecorder = null;
  var groqSliceTimerId = null;
  var recorderMime = "";
  var groqQueue = [];
  var groqPumpRunning = false;
  var polishTimer = null;
  var polishInFlight = false;
  var translateTimer = null;
  /** Число активных запросов перевода (допускается >1 при force). */
  var translateJobs = 0;
  /** Пока идёт запрос, пришёл более новый текст — повторить после ответа. */
  var translatePending = false;
  /** Очередь: после текущего запроса выполнить с force (например после постобработки). */
  var translatePendingWantForce = false;
  /** После 429 — не слать новые запросы до этого времени (epoch ms). */
  var translateBackoffUntil = 0;
  var translateRequestSeq = 0;

  function canUseBrowserSpeech() {
    return !!SPEECH_RECOGNITION;
  }

  function canUseGroqMic() {
    return (
      typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof MediaRecorder !== "undefined"
    );
  }

  function micSupported() {
    if (speechConfig.mode === "groq") return canUseGroqMic();
    return canUseBrowserSpeech();
  }

  function scrollTranscriptToEnd() {
    if (!elTranscriptScroll) return;
    elTranscriptScroll.scrollTop = elTranscriptScroll.scrollHeight;
  }

  function setSpeechChrome(title, ariaLabel) {
    if (!elTranscriptToggle) return;
    elTranscriptToggle.setAttribute("title", title);
    elTranscriptToggle.setAttribute("aria-label", ariaLabel || title);
  }

  function setSpeechUiListening(active) {
    if (!elTranscriptToggle) return;
    elTranscriptToggle.setAttribute("aria-pressed", active ? "true" : "false");
    elTranscriptToggle.classList.toggle("icon-btn--speech-active", active);
    if (active) {
      setSpeechChrome("Остановить распознавание", "Остановить распознавание речи");
    } else {
      setSpeechChrome(
        "Включить распознавание (Shift+клик — очистить текст)",
        "Включить распознавание речи"
      );
    }
  }

  function normalizeSpeechWhitespace(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/^\s+|\s+$/g, "");
  }

  /** Склейка фрагментов без локальной пунктуации и капитализации. */
  function appendSpeechPlain(accumulated, rawPiece) {
    var piece = normalizeSpeechWhitespace(rawPiece);
    if (!piece) return accumulated;
    if (!accumulated) return piece;
    return accumulated + " " + piece;
  }

  function clearTranscriptText() {
    speechFinalText = "";
    translatedDisplayText = "";
    groqQueue.length = 0;
    if (elTranscriptFinal) elTranscriptFinal.textContent = "";
    if (elTranscriptInterim) elTranscriptInterim.textContent = "";
    if (polishTimer) {
      global.clearTimeout(polishTimer);
      polishTimer = null;
    }
    if (translateTimer) {
      global.clearTimeout(translateTimer);
      translateTimer = null;
    }
    translatePending = false;
    translatePendingWantForce = false;
    translateBackoffUntil = 0;
  }

  function refreshTranscriptFinalDisplay() {
    if (!elTranscriptFinal) return;
    if (speechConfig.translateEnabled) {
      elTranscriptFinal.textContent = translatedDisplayText;
    } else {
      elTranscriptFinal.textContent = speechFinalText;
    }
  }

  function onTranscriptSourceUpdated() {
    schedulePolish();
    if (speechConfig.translateEnabled) {
      scheduleTranslate();
    }
  }

  function scheduleTranslate() {
    if (!speechConfig.translateEnabled) return;
    if (translateTimer) global.clearTimeout(translateTimer);
    translateTimer = global.setTimeout(function () {
      translateTimer = null;
      runTranslateGroq();
    }, TRANSLATE_DEBOUNCE_MS);
  }

  function translateBackoffWaitMs() {
    var t = translateBackoffUntil - Date.now();
    return t > 0 ? t : 0;
  }

  function translateSystemPrompt() {
    if (speechConfig.translateTarget === "zh") {
      return (
        "Переведи следующий текст на упрощённый китайский (简体中文). Сохрани смысл. " +
        "Технические термины, имена собственные, латиница и фрагменты кода не переводи буквально, если так принято в отрасли — оставь латиницу или транслитерируй аккуратно. " +
        "Верни только перевод, без пояснений и префиксов."
      );
    }
    return (
      "Translate the following into clear English. Preserve meaning. " +
      "Keep technical terms, API names, code fragments, and established English borrowings as appropriate; do not gratuitously Russianize English terms. " +
      "Return only the translation, no notes."
    );
  }

  function runTranslateGroq(opts) {
    var force = opts && opts.force;
    if (!speechConfig.translateEnabled) return;
    var src = normalizeSpeechWhitespace(speechFinalText);
    if (!src) {
      translatedDisplayText = "";
      translatePending = false;
      translatePendingWantForce = false;
      refreshTranscriptFinalDisplay();
      return;
    }
    /* Одна операция перевода за раз — иначе Groq отвечает 429. force только в очереди. */
    if (translateJobs > 0) {
      translatePending = true;
      if (force) translatePendingWantForce = true;
      return;
    }
    var backoff = translateBackoffWaitMs();
    if (backoff > 0 && !force) {
      global.setTimeout(function () {
        runTranslateGroq(opts);
      }, backoff + 30);
      return;
    }
    translateJobs += 1;
    translateRequestSeq += 1;
    var seq = translateRequestSeq;
    var snapshot = src;

    callGroqProxy({
      action: "chat",
      model: speechConfig.chatModel || "llama-3.1-8b-instant",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: translateSystemPrompt()
        },
        {
          role: "user",
          content: snapshot
        }
      ]
    })
      .then(function (data) {
        if (seq !== translateRequestSeq) return;
        var text = data && typeof data.text === "string" ? data.text.trim() : "";
        if (!text) return;
        translatedDisplayText = text;
        refreshTranscriptFinalDisplay();
        scrollTranscriptToEnd();
        if (speechWantListen) {
          setSpeechChrome("Остановить распознавание", "Остановить распознавание речи");
        }
      })
      .catch(function (err) {
        var http = err && typeof err.httpStatus === "number" ? err.httpStatus : 0;
        if (http === 429) {
          translateBackoffUntil = Date.now() + 2800;
          translatePending = true;
          translatePendingWantForce = true;
          setSpeechChrome(
            "Перевод: лимит запросов Groq (429). Повтор через несколько секунд.",
            "Ошибка перевода: слишком много запросов к API"
          );
        } else if (speechDebug()) {
          var m = err && err.message ? err.message : String(err);
          console.warn("[speech] перевод Groq:", m);
        }
      })
      .then(function () {
        translateJobs = Math.max(0, translateJobs - 1);
        if (translatePending && speechConfig.translateEnabled && translateJobs === 0) {
          translatePending = false;
          var flushForce = translatePendingWantForce;
          translatePendingWantForce = false;
          var wait = translateBackoffWaitMs();
          global.setTimeout(function () {
            runTranslateGroq({ force: flushForce });
          }, wait);
        }
      });
  }

  function speechErrorLabel(code) {
    var map = {
      "not-allowed":
        "Нет доступа к микрофону. Разрешите доступ в настройках браузера.",
      aborted: "",
      "audio-capture": "Микрофон недоступен.",
      network: "Ошибка сети при распознавании.",
      "service-not-allowed": "Сервис распознавания недоступен."
    };
    return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : "";
  }

  function pickRecorderMime() {
    var types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    var i;
    for (i = 0; i < types.length; i++) {
      if (MediaRecorder.isTypeSupported(types[i])) return types[i];
    }
    return "";
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () {
        var s = String(reader.result || "");
        var comma = s.indexOf(",");
        if (comma === -1) {
          reject(new Error("Не удалось закодировать аудио"));
          return;
        }
        resolve(s.slice(comma + 1));
      };
      reader.onerror = function () {
        reject(new Error("Ошибка чтения аудио"));
      };
      reader.readAsDataURL(blob);
    });
  }

  function callGroqProxy(payload) {
    var action = payload && payload.action ? String(payload.action) : "";
    var headers = { "Content-Type": "application/json" };
    var key = speechConfig.groqClientKey ? String(speechConfig.groqClientKey).trim() : "";
    if (key) {
      headers.Authorization = "Bearer " + key;
    }
    var bodyStr = JSON.stringify(payload);
    if (speechDebug()) {
      console.log(
        "[speech] fetch",
        GROQ_API_PATH,
        "action=" + action,
        "bodyChars=" + bodyStr.length
      );
    }
    return fetch(GROQ_API_PATH, {
      method: "POST",
      headers: headers,
      body: bodyStr
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch (e) {
            if (res.ok && speechDebug()) {
              console.warn(
                "[speech] ответ /api/groq не JSON при HTTP",
                res.status + ":",
                e && e.message,
                raw.slice(0, 500)
              );
            }
            if (!res.ok) {
              var errParse = new Error(
                "Сервер: " + (raw.length > 160 ? raw.slice(0, 160) + "…" : raw || res.statusText)
              );
              errParse.groqAction = action;
              throw errParse;
            }
          }
        }
        if (!res.ok) {
          var msg =
            data && typeof data.error === "string"
              ? data.error
              : "HTTP " + String(res.status);
          var errHttp = new Error(msg + " [" + res.status + "]");
          errHttp.groqAction = action;
          errHttp.httpStatus = res.status;
          throw errHttp;
        }
        if (speechDebug()) {
          console.log("[speech] ответ OK action=" + action, "rawLen=" + raw.length, "keys=", Object.keys(data || {}));
        }
        return data;
      });
    });
  }

  function schedulePolish() {
    if (!speechConfig.groqPostProcess) return;
    if (polishTimer) global.clearTimeout(polishTimer);
    polishTimer = global.setTimeout(function () {
      polishTimer = null;
      runPolishGroq();
    }, POLISH_DEBOUNCE_MS);
  }

  function runPolishGroq(opts) {
    var force = opts && opts.force;
    if (!speechFinalText || polishInFlight) return;
    if (!force && !speechWantListen) return;
    polishInFlight = true;
    var snapshot = speechFinalText;
    callGroqProxy({
      action: "chat",
      model: speechConfig.chatModel || "llama-3.1-8b-instant",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Ты редактор расшифровки устной речи на встрече. Исправь орфографию и пунктуацию, убери явные ошибки распознавания. Осмысленно разбей текст на предложения и добавь везде необходимые знаки пунктуации. Основной язык — русский; не переводи и не «исправляй» осмысленные английские термины, имена собственные и латиницу — оставь как в оригинале. Сохрани смысл. Верни только исправленный текст, без пояснений."
        },
        {
          role: "user",
          content: snapshot
        }
      ]
    })
      .then(function (data) {
        var text = data && typeof data.text === "string" ? data.text.trim() : "";
        if (speechDebug()) {
          console.log("[speech] chat постобработка: textLen=" + text.length);
        }
        if (!text) {
          if (speechDebug()) {
            console.warn("[speech] chat: пустой text", data);
          }
          return;
        }
        speechFinalText = text;
        refreshTranscriptFinalDisplay();
        scrollTranscriptToEnd();
      })
      .catch(function (err) {
        var m = err && err.message ? err.message : String(err);
        if (err && err.groqAction === "chat") {
          if (speechDebug()) {
            console.warn("[Groq постобработка]", m);
          }
          setSpeechChrome(
            "Транскрипт без правок LLM (ошибка постобработки — см. консоль)",
            "Постобработка Groq недоступна, текст распознавания сохранён"
          );
          return;
        }
        setSpeechChrome("Постобработка: " + m, "Постобработка: " + m);
      })
      .then(function () {
        polishInFlight = false;
        if (speechConfig.translateEnabled && speechConfig.groqPostProcess) {
          global.setTimeout(function () {
            runTranslateGroq({ force: true });
          }, 60);
        }
      });
  }

  function looksLikeSilenceHallucination(text) {
    var t = normalizeSpeechWhitespace(text);
    if (!t) return true;
    var low = t.toLowerCase();
    /* Не отсекать короткие «Да», «Ок», «Нет» — только типичный мусор субтитров / тишины Whisper. */
    if (/^(thank you|thanks for watching|subscribe|subtitles)/i.test(t)) return true;
    /* RU: частые галлюцинации на тишине/шуме */
    if (/продолжение\s+следует/i.test(low)) return true;
    if (/^доброе\s+утро[.!…]*$/i.test(t)) return true;
    if (/^спасибо[.!…\s]*$/i.test(t) && t.length < 24) return true;
    if (/субтитр|подписка\s+на\s+канал|ставьте\s+лайк/i.test(low)) return true;
    if (/^\[музыка]$/i.test(t)) return true;
    return false;
  }

  function applyGroqTranscriptPiece(piece) {
    var trimmed = normalizeSpeechWhitespace(piece);
    if (!trimmed) {
      if (speechDebug()) {
        console.info("[speech] фрагмент STT пустой после нормализации");
      }
      return;
    }
    if (looksLikeSilenceHallucination(trimmed)) {
      if (speechDebug()) {
        console.info("[speech] отброшен как типичный мусор STT:", trimmed.slice(0, 120));
      }
      return;
    }
    speechFinalText = appendSpeechPlain(speechFinalText, trimmed);
    refreshTranscriptFinalDisplay();
    if (elTranscriptInterim) elTranscriptInterim.textContent = "";
    scrollTranscriptToEnd();
    onTranscriptSourceUpdated();
  }

  function processOneGroqBlob(blob, mimeHint) {
    if (!blob || blob.size < GROQ_MIN_CHUNK_BYTES) {
      if (speechDebug()) {
        console.info(
          "[speech] чанк не отправлен: bytes=" + (blob && blob.size) + " < " + GROQ_MIN_CHUNK_BYTES
        );
      }
      return Promise.resolve();
    }
    var mime = mimeHint || blob.type || "audio/webm";
    var ext = mime.indexOf("mp4") !== -1 ? "m4a" : "webm";
    return blobToBase64(blob).then(function (b64) {
      if (speechDebug()) {
        console.info(
          "[speech] transcribe → сервер: blobBytes=" + blob.size + " b64chars=" + b64.length + " mime=" + mime
        );
      }
      return callGroqProxy({
        action: "transcribe",
        audioBase64: b64,
        filename: "chunk." + ext,
        mimeType: mime,
        model: speechConfig.sttModel || "whisper-large-v3-turbo",
        language: "auto",
        prompt: GROQ_TRANSCRIBE_PROMPT
      }).then(function (data) {
        var t = "";
        if (data && data.text != null) {
          t = typeof data.text === "string" ? data.text : String(data.text);
        }
        if (speechDebug()) {
          var preview = t.length > 160 ? t.slice(0, 160) + "…" : t;
          console.info("[speech] transcribe ← сервер: textLen=" + t.length + " preview=" + JSON.stringify(preview));
          if (!t.trim()) {
            console.warn("[speech] transcribe: пустой text в JSON 200; объект ответа:", data);
          }
          console.log("[speech] transcribe полный ответ:", data);
        }
        applyGroqTranscriptPiece(t);
      });
    });
  }

  function pumpGroqQueue() {
    if (groqPumpRunning) return;
    var item = groqQueue.shift();
    if (!item) return;
    groqPumpRunning = true;
    processOneGroqBlob(item.blob, item.mime)
      .catch(function (err) {
        var m = err && err.message ? err.message : String(err);
        if (err && err.groqAction === "transcribe") {
          setSpeechChrome("Транскрипция Groq: " + m, "Транскрипция Groq: " + m);
          return;
        }
        setSpeechChrome("Groq: " + m, "Groq: " + m);
      })
      .then(function () {
        groqPumpRunning = false;
        if (groqQueue.length) pumpGroqQueue();
      });
  }

  function enqueueGroqBlob(blob, mimeHint) {
    if (speechDebug()) {
      console.info("[speech] в очередь STT: bytes=" + blob.size + " queueLen=" + (groqQueue.length + 1));
    }
    groqQueue.push({ blob: blob, mime: mimeHint });
    pumpGroqQueue();
  }

  /**
   * Нельзя использовать start(timeslice): куски WebM с таймслейсом часто не являются
   * цельными файлами — Groq STT отвечает 400. Делаем полные сегменты: start → stop по таймеру.
   */
  function beginGroqRecorderSlice() {
    if (!speechWantListen || !mediaStream) return;
    var options = recorderMime ? { mimeType: recorderMime } : undefined;
    var chunks = [];
    try {
      mediaRecorder = new MediaRecorder(mediaStream, options);
    } catch (err) {
      speechWantListen = false;
      setSpeechUiListening(false);
      setSpeechChrome("Не удалось создать запись", "Не удалось создать запись");
      return;
    }
    mediaRecorder.ondataavailable = function (ev) {
      if (ev.data && ev.data.size) chunks.push(ev.data);
    };
    mediaRecorder.onerror = function () {
      speechWantListen = false;
      if (groqSliceTimerId) {
        global.clearTimeout(groqSliceTimerId);
        groqSliceTimerId = null;
      }
      setSpeechUiListening(false);
      setSpeechChrome("Ошибка записи аудио", "Ошибка записи аудио");
    };
    mediaRecorder.onstop = function () {
      if (groqSliceTimerId) {
        global.clearTimeout(groqSliceTimerId);
        groqSliceTimerId = null;
      }
      var blob = new Blob(chunks, { type: recorderMime || "audio/webm" });
      chunks = [];
      if (blob.size >= GROQ_MIN_CHUNK_BYTES) {
        enqueueGroqBlob(blob, recorderMime || blob.type);
      } else if (speechDebug()) {
        console.info("[speech] сегмент записи слишком мал для STT: bytes=" + blob.size);
      }
      if (speechWantListen && mediaStream && mediaStream.active) {
        global.setTimeout(beginGroqRecorderSlice, 0);
      } else {
        mediaRecorder = null;
      }
    };
    try {
      mediaRecorder.start();
    } catch (err2) {
      speechWantListen = false;
      setSpeechUiListening(false);
      setSpeechChrome("Не удалось начать запись", "Не удалось начать запись");
      return;
    }
    groqSliceTimerId = global.setTimeout(function () {
      groqSliceTimerId = null;
      if (mediaRecorder && mediaRecorder.state === "recording") {
        try {
          mediaRecorder.stop();
        } catch (e) {
          /* ignore */
        }
      }
    }, GROQ_SLICE_MS);
  }

  /* Groq: AEC/NS/AGC выключены по умолчанию — иначе Chrome глушит звук из колонков как «эхо». */
  function getGroqMicConstraints() {
    return {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    };
  }

  function startGroqCaptureFromMic() {
    speechWantListen = true;
    var constraints = getGroqMicConstraints();
    var tryFallback = true;

    function onGotStream(stream) {
      if (!speechWantListen) {
        stream.getTracks().forEach(function (t) {
          t.stop();
        });
        return;
      }
      mediaStream = stream;
      recorderMime = pickRecorderMime();
      beginGroqRecorderSlice();
      setSpeechUiListening(true);
    }

    function onFail(err) {
      if (tryFallback) {
        tryFallback = false;
        return navigator.mediaDevices.getUserMedia({ audio: true }).then(onGotStream).catch(onFailFinal);
      }
      onFailFinal(err);
    }

    function onFailFinal() {
      speechWantListen = false;
      setSpeechUiListening(false);
      setSpeechChrome(
        "Нет доступа к микрофону для Groq",
        "Нет доступа к микрофону для Groq"
      );
    }

    navigator.mediaDevices
      .getUserMedia(constraints)
      .then(onGotStream)
      .catch(onFail);
  }

  function startGroqCapture() {
    if (!canUseGroqMic()) return;
    startGroqCaptureFromMic();
  }

  function attachSpeechRecognitionHandlers(rec) {
    rec.onresult = function (event) {
      var interim = "";
      var i;
      var hadFinal = false;
      for (i = event.resultIndex; i < event.results.length; i++) {
        var piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          hadFinal = true;
          speechFinalText = appendSpeechPlain(speechFinalText, piece);
        } else {
          interim += piece;
        }
      }
      refreshTranscriptFinalDisplay();
      if (elTranscriptInterim) {
        elTranscriptInterim.textContent = speechConfig.translateEnabled
          ? ""
          : normalizeSpeechWhitespace(interim);
      }
      scrollTranscriptToEnd();
      if (hadFinal) onTranscriptSourceUpdated();
    };

    rec.onerror = function (event) {
      if (event.error === "no-speech" || event.error === "aborted") {
        return;
      }
      var fatal =
        event.error === "not-allowed" ||
        event.error === "service-not-allowed" ||
        event.error === "audio-capture" ||
        event.error === "network";
      if (fatal) {
        stopAllCapture();
      }
      var msg = speechErrorLabel(event.error);
      if (!msg && event.error) {
        msg = "Ошибка: " + String(event.error);
      }
      if (msg) setSpeechChrome(msg, msg);
    };

    rec.onend = function () {
      if (speechWantListen && speechRecognition === rec) {
        global.setTimeout(function () {
          if (!speechWantListen || speechRecognition !== rec) return;
          try {
            rec.start();
          } catch (error) {
            speechWantListen = false;
            setSpeechUiListening(false);
            setSpeechChrome(
              "Не удалось возобновить распознавание",
              "Не удалось возобновить распознавание"
            );
          }
        }, 120);
      } else {
        setSpeechUiListening(false);
      }
    };
  }

  function startSpeechRecognition() {
    if (speechConfig.mode === "groq") {
      startGroqCapture();
      return;
    }
    if (!SPEECH_RECOGNITION || !elTranscriptToggle) return;
    speechWantListen = true;
    if (!speechRecognition) {
      speechRecognition = new SPEECH_RECOGNITION();
      speechRecognition.lang = SPEECH_LANG;
      speechRecognition.continuous = true;
      speechRecognition.interimResults = true;
      speechRecognition.maxAlternatives = 1;
      attachSpeechRecognitionHandlers(speechRecognition);
    }
    try {
      speechRecognition.start();
      setSpeechUiListening(true);
    } catch (error) {
      speechWantListen = false;
      setSpeechUiListening(false);
      setSpeechChrome(
        "Не удалось запустить распознавание",
        "Не удалось запустить распознавание"
      );
    }
  }

  function stopAllCapture() {
    speechWantListen = false;
    if (groqSliceTimerId) {
      global.clearTimeout(groqSliceTimerId);
      groqSliceTimerId = null;
    }
    if (polishTimer) {
      global.clearTimeout(polishTimer);
      polishTimer = null;
    }
    if (translateTimer) {
      global.clearTimeout(translateTimer);
      translateTimer = null;
    }
    if (speechRecognition) {
      try {
        speechRecognition.stop();
      } catch (error) {
        /* ignore */
      }
    }
    if (mediaRecorder && mediaRecorder.state === "recording") {
      try {
        mediaRecorder.requestData();
      } catch (e) {
        /* ignore */
      }
      try {
        mediaRecorder.stop();
      } catch (e2) {
        /* ignore */
      }
    }
    mediaRecorder = null;
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) {
        t.stop();
      });
      mediaStream = null;
    }
    setSpeechUiListening(false);
    if (speechConfig.groqPostProcess && speechFinalText) {
      global.setTimeout(function () {
        runPolishGroq({ force: true });
      }, POLISH_DEBOUNCE_MS + 200);
    } else if (speechConfig.translateEnabled && speechFinalText) {
      global.setTimeout(function () {
        runTranslateGroq({ force: true });
      }, 450);
    }
  }

  function updateMicDisabledState() {
    if (!elTranscriptToggle) return;
    elTranscriptToggle.disabled = !micSupported();
    if (elTranscriptToggle.disabled) {
      setSpeechChrome(
        "Распознавание недоступно в этом браузере для выбранного режима",
        "Распознавание недоступно"
      );
    } else if (!speechWantListen) {
      setSpeechChrome(
        "Включить распознавание (Shift+клик — очистить текст)",
        "Включить распознавание речи"
      );
    }
  }

  function configure(next) {
    if (!next || typeof next !== "object") return;
    var prevMode = speechConfig.mode;
    speechConfig.mode = next.mode === "groq" ? "groq" : "browser";
    speechConfig.groqPostProcess = Boolean(next.groqPostProcess);
    speechConfig.groqClientKey =
      typeof next.groqClientKey === "string" ? next.groqClientKey : "";
    speechConfig.sttModel =
      next.sttModel === "whisper-large-v3" ? "whisper-large-v3" : "whisper-large-v3-turbo";
    speechConfig.chatModel =
      typeof next.chatModel === "string" && next.chatModel.trim()
        ? next.chatModel.trim()
        : "llama-3.1-8b-instant";
    speechConfig.translateEnabled = Boolean(next.translateEnabled);
    speechConfig.translateTarget = next.translateTarget === "zh" ? "zh" : "en";

    if (!speechConfig.translateEnabled) {
      if (translateTimer) {
        global.clearTimeout(translateTimer);
        translateTimer = null;
      }
      translateRequestSeq += 1;
      translatePending = false;
      translatePendingWantForce = false;
      translateBackoffUntil = 0;
      translatedDisplayText = "";
    }
    refreshTranscriptFinalDisplay();
    if (
      speechConfig.translateEnabled &&
      normalizeSpeechWhitespace(speechFinalText)
    ) {
      global.setTimeout(function () {
        runTranslateGroq();
      }, 80);
    }

    if (prevMode !== speechConfig.mode && speechWantListen) {
      stopAllCapture();
    }
    updateMicDisabledState();
  }

  function init() {
    elTranscriptToggle = document.getElementById("transcript-toggle");
    elTranscriptScroll = document.getElementById("transcript-scroll");
    elTranscriptFinal = document.getElementById("transcript-final");
    elTranscriptInterim = document.getElementById("transcript-interim");

    if (!elTranscriptToggle) return;

    refreshTranscriptFinalDisplay();
    updateMicDisabledState();

    elTranscriptToggle.addEventListener("click", function (event) {
      if (event.shiftKey && !speechWantListen) {
        event.preventDefault();
        clearTranscriptText();
        setSpeechChrome("Текст очищен", "Текст транскрипта очищен");
        return;
      }

      if (speechWantListen) {
        stopAllCapture();
        setSpeechChrome("Остановлено.", "Распознавание остановлено");
      } else {
        startSpeechRecognition();
      }
    });
  }

  function handleDocumentEscape() {
    if (!speechWantListen) return false;
    stopAllCapture();
    setSpeechChrome("Остановлено.", "Распознавание остановлено");
    return true;
  }

  global.startTrackerSpeech = {
    init: init,
    configure: configure,
    handleDocumentEscape: handleDocumentEscape
  };
})(typeof window !== "undefined" ? window : this);

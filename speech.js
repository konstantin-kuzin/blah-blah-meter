(function (global) {
  "use strict";

  var SPEECH_LANG = "ru-RU";
  var SPEECH_RECOGNITION =
    typeof global !== "undefined"
      ? global.SpeechRecognition || global.webkitSpeechRecognition
      : null;

  var speechRecognition = null;
  var speechWantListen = false;
  var speechFinalText = "";

  var elTranscriptToggle = null;
  var elTranscriptScroll = null;
  var elTranscriptFinal = null;
  var elTranscriptInterim = null;

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

  function capitalizeFirstWord(value) {
    if (!value) return value;
    var first = value.charAt(0);
    if (/[а-яёА-ЯЁa-zA-Z]/.test(first)) {
      return first.toLocaleUpperCase("ru-RU") + value.slice(1);
    }
    return value;
  }

  function endsWithClausePunctuation(value) {
    return /[.!?…]\s*$/.test(value);
  }

  function endsWithWeakPunctuation(value) {
    return /[,;:]\s*$/.test(value);
  }

  function startsWithPunctuationOrBracket(value) {
    return /^[.,!?…:;)\]}»«"'„]/.test(value);
  }

  function appendFinalSpeechSegment(accumulated, rawPiece) {
    var piece = normalizeSpeechWhitespace(rawPiece);
    if (!piece) return accumulated;

    if (!accumulated) {
      return capitalizeFirstWord(piece);
    }

    var acc = accumulated.replace(/\s+$/, "");
    var joiner;
    var nextPiece = piece;

    if (startsWithPunctuationOrBracket(piece)) {
      joiner = "";
    } else if (endsWithClausePunctuation(acc) || endsWithWeakPunctuation(acc)) {
      joiner = " ";
    } else {
      joiner = ". ";
      nextPiece = capitalizeFirstWord(piece);
    }

    if (!/\s$/.test(acc) && joiner.length) {
      return acc + joiner + nextPiece;
    }

    return acc + nextPiece;
  }

  function polishTranscriptRu(value) {
    var text = normalizeSpeechWhitespace(value);
    if (!text) return text;

    text = text.replace(/(^|[.!?…]\s+)([а-яёa-zA-Z])/gi, function (_, sep, ch) {
      return sep + ch.toLocaleUpperCase("ru-RU");
    });

    return capitalizeFirstWord(text);
  }

  function clearTranscriptText() {
    speechFinalText = "";
    if (elTranscriptFinal) elTranscriptFinal.textContent = "";
    if (elTranscriptInterim) elTranscriptInterim.textContent = "";
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

  function stopSpeechRecognition() {
    speechWantListen = false;
    if (speechRecognition) {
      try {
        speechRecognition.stop();
      } catch (error) {
        /* ignore */
      }
    }
    setSpeechUiListening(false);
  }

  function attachSpeechRecognitionHandlers(rec) {
    rec.onresult = function (event) {
      var interim = "";
      var i;
      for (i = event.resultIndex; i < event.results.length; i++) {
        var piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          speechFinalText = polishTranscriptRu(
            appendFinalSpeechSegment(speechFinalText, piece)
          );
        } else {
          interim += piece;
        }
      }
      if (elTranscriptFinal) elTranscriptFinal.textContent = speechFinalText;
      if (elTranscriptInterim) {
        elTranscriptInterim.textContent = normalizeSpeechWhitespace(interim);
      }
      scrollTranscriptToEnd();
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
        speechWantListen = false;
        setSpeechUiListening(false);
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

  function init() {
    elTranscriptToggle = document.getElementById("transcript-toggle");
    elTranscriptScroll = document.getElementById("transcript-scroll");
    elTranscriptFinal = document.getElementById("transcript-final");
    elTranscriptInterim = document.getElementById("transcript-interim");

    if (!elTranscriptToggle) return;

    if (!SPEECH_RECOGNITION) {
      elTranscriptToggle.disabled = true;
      setSpeechChrome(
        "Распознавание не поддерживается в этом браузере",
        "Распознавание речи не поддерживается"
      );
      return;
    }

    elTranscriptToggle.addEventListener("click", function (event) {
      if (event.shiftKey && !speechWantListen) {
        event.preventDefault();
        clearTranscriptText();
        setSpeechChrome("Текст очищен", "Текст транскрипта очищен");
        return;
      }

      if (speechWantListen) {
        stopSpeechRecognition();
        setSpeechChrome("Остановлено.", "Распознавание остановлено");
      } else {
        startSpeechRecognition();
      }
    });
  }

  function handleDocumentEscape() {
    if (!speechWantListen) return false;
    stopSpeechRecognition();
    setSpeechChrome("Остановлено.", "Распознавание остановлено");
    return true;
  }

  global.ResourceWasteTrackerSpeech = {
    init: init,
    handleDocumentEscape: handleDocumentEscape
  };
})(typeof window !== "undefined" ? window : this);

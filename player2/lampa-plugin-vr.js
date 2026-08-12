// Плагин для Lampa: кнопка "Смотреть в VR" в панели плеера.
// По клику открывает player2 (Ambilight VR) в новой вкладке/окне,
// передавая ему прямую ссылку на уже выбранный Lampa'ой поток.
//
// Как подключить:
//   1. player2 и этот плагин выложены на GitHub Pages (публично, Lampa
//      сможет достучаться откуда угодно, не только из локальной сети):
//      https://zeprogress.github.io/player2-lampa/player2/index.html
//   2. В Lampa: Настройки → Плагины → вставить ссылку на этот файл:
//      https://zeprogress.github.io/player2-lampa/player2/lampa-plugin-vr.js
//
// Проверено по реальному исходнику Lampa (src/interaction/player.js,
// src/templates/player/panel.js), но НЕ проверено внутри самой Lampa —
// после подключения стоит открыть любой фильм и посмотреть, появилась ли
// кнопка в панели плеера рядом с иконкой настроек.
(function () {
  'use strict';
  if (!window.Lampa) return;

  var VR_PLAYER_URL = 'https://zeprogress.github.io/player2-lampa/player2/index.html';

  function makeButton(streamUrl) {
    var btn = $(
      '<div class="player-panel__vr button selector" title="Смотреть в VR">' +
        '<svg viewBox="0 0 24 24" width="22" height="22">' +
          '<path fill="currentColor" d="M21 6H3a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h5.5l1.5-2h4l1.5 2H21a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zM7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm10 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>' +
        '</svg>' +
      '</div>'
    );
    btn.on('hover:enter click', function () {
      var url = VR_PLAYER_URL + '?video=' + encodeURIComponent(streamUrl);
      window.open(url, '_blank');
    });
    return btn;
  }

  // Разметка панели плеера у Lampa содержит НЕСКОЛЬКО .player-panel__right —
  // отдельно для ТВ-раскладки (.player-panel__tv-visible, там несколько
  // .player-panel__box-buttons: качество / дорожки-субтитры / настройки-pip)
  // и отдельно для мобильной/десктопной (.player-panel__mobile-visible, там
  // одна). Раньше кнопка добавлялась только в первую попавшуюся — если она
  // относилась к скрытому в вашем режиме варианту, кнопки не было видно.
  // Теперь добавляем во ВСЕ такие группы сразу.
  // Console нет на ТВ/телефоне — показываем отладку прямо в интерфейсе
  // Lampa всплывающим уведомлением, один раз для каждого события.
  function debugNoty(text) {
    if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show('[VR] ' + text);
  }

  function addButton(streamUrl) {
    var root = Lampa.Player.render();
    if (!root || !root.length) {
      debugNoty('панель плеера ещё не создана');
      return;
    }

    var groups = root.find('.player-panel__right .player-panel__box-buttons');
    debugNoty('групп кнопок найдено: ' + groups.length);
    if (!groups.length) {
      // Печатать в консоли некому — просто показываем реальную разметку
      // панели через alert (не требует ни клавиатуры, ни консоли, только
      // кнопку "ОК"), чтобы поправить селектор по факту.
      var dump = root.find('.player-panel__line-two').prop('outerHTML')
        || root.find('.player-panel').prop('outerHTML')
        || '(панель не найдена вообще)';
      alert('[VR] разметка панели:\n' + String(dump).slice(0, 1800));
      return;
    }

    groups.each(function () {
      var group = $(this);
      if (group.find('.player-panel__vr').length) return; // уже добавлена
      group.prepend(makeButton(streamUrl));
    });
  }

  // 'ready' стреляет, когда плеер получил ссылку и готов играть —
  // data.url это уже разрешённый Lampa'ой прямой адрес потока.
  Lampa.Player.listener.follow('ready', function (data) {
    debugNoty('событие ready, url есть: ' + !!(data && data.url));
    if (data && data.url) addButton(data.url);
  });
})();

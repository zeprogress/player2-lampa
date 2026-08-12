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

  function addButton(streamUrl) {
    var root = Lampa.Player.render();
    if (!root || !root.length) return;

    var group = root.find('.player-panel__right .player-panel__box-buttons').first();
    if (!group.length) return;
    if (group.find('.player-panel__vr').length) return; // уже добавлена

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

    group.prepend(btn);
  }

  // 'ready' стреляет, когда плеер получил ссылку и готов играть —
  // data.url это уже разрешённый Lampa'ой прямой адрес потока.
  Lampa.Player.listener.follow('ready', function (data) {
    if (data && data.url) addButton(data.url);
  });
})();

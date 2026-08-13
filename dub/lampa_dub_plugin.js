/*
 * AI-озвучка для Lampa (Fish Audio TTS, модель s2.1-pro-free).
 *
 * Архитектура (см. Dub/README-обсуждение в чате):
 *  - субтитры берём по ссылке из Lampa.Player.playdata().subtitles[i].url
 *    (та же дорожка, что уже показывает сама Lampa) и парсим сами —
 *    публичного API для чтения активной дорожки у Lampa нет;
 *  - озвучка идёт "по мере просмотра": реплики на ближайшие ~15с вперёд
 *    досинтезируются в фоне, а не всё сразу при старте;
 *  - к Fish Audio плагин НЕ ходит напрямую: у /v1/tts нет CORS для
 *    браузерных запросов (проверено — preflight отвечает 401 без единого
 *    Access-Control-* заголовка), а WebSocket-путь тоже недоступен из
 *    браузера (нельзя выставить Authorization-заголовок на хендшейке).
 *    Поэтому запросы идут через собственный Cloudflare Worker-прокси
 *    (fish-tts-proxy), который хранит ключ как секрет и сам добавляет
 *    Authorization + CORS-заголовки на ответ;
 *  - таймингам не подчиняемся жёстко: если реплика длиннее своего окна,
 *    ускоряем её ровно настолько, чтобы не залезть в начало СЛЕДУЮЩЕЙ
 *    реплики больше чем на OVERLAP_TOLERANCE_MS — лёгкое наложение
 *    в быстром диалоге это нормально (см. dub_batch.py);
 *  - воспроизведение — Web Audio API (AudioBufferSourceNode), не
 *    <audio>-теги: так можно точно спланировать старт каждой реплики
 *    и не бороться с play()/pause() гонками.
 *
 * ВАЖНО про type:'input' в Lampa.SettingsApi.addParam: обязательно нужно
 * поле param.values (пустая строка '' для свободного текстового ввода,
 * не select) — без него Lampa падает при рендере строки настроек
 * (TypeError: Cannot read properties of undefined), это подтверждённая
 * особенность её внутреннего Params.select(), общая и для select и для
 * input типов.
 */
(function () {
    'use strict';
    if (!window.Lampa) return;

    var LOG_PREFIX = '[ai-dub]';

    var TTS_PROXY_URL = 'https://fish-tts-proxy.player2vr.workers.dev/';
    var REFERENCE_ID = 'c4ec5839e2044150aad40ac193a602f1'; // "Володарский"

    var LOOKAHEAD_MS = 15000;      // на сколько вперёд по времени видео досинтезируем
    var OVERLAP_TOLERANCE_MS = 300; // сколько наложения на следующую реплику терпим
    var DUCK_VOLUME = 0.15;        // громкость оригинала при активной озвучке
    var DUCK_RAMP_MS = 250;        // за сколько плавно менять громкость при приглушении/восстановлении
    var SUB_FETCH_TIMEOUT_MS = 120000; // сколько ждать субтитры от TorrServer на холодном торренте
    var SEEK_SETTLE_MS = 1500;     // сколько ждать после перемотки, пока currentTime не перестанет скакать

    // Плавно меняет громкость САМОГО <video> (не через Lampa.PlayerVideo.volume() —
    // та ещё и сохраняет значение как пользовательскую настройку громкости в
    // Storage, а наше приглушение на время реплики — временное и не должно
    // перезаписывать реальную громкость, которую выставил себе пользователь).
    var volumeRampFrame = null;
    function rampVolume(video, targetVol, durationMs) {
        if (!video) return;
        if (volumeRampFrame) cancelAnimationFrame(volumeRampFrame);
        var startVol = video.volume;
        var startTime = performance.now();
        function step(now) {
            var t = Math.min(1, (now - startTime) / durationMs);
            video.volume = startVol + (targetVol - startVol) * t;
            if (t < 1) volumeRampFrame = requestAnimationFrame(step);
            else volumeRampFrame = null;
        }
        volumeRampFrame = requestAnimationFrame(step);
    }

    // ---------------------------------------------------------------
    // Настройка: тумблер "AI-озвучка" в Настройках плеера
    // ---------------------------------------------------------------
    if (Lampa.SettingsApi) {
        Lampa.SettingsApi.addParam({
            component: 'player',
            param: { name: 'ai_dub_enabled', type: 'trigger', default: false },
            field: { name: 'AI-озвучка (Fish Audio)', description: 'Экспериментальный синхронный ИИ-дубляж поверх оригинальной дорожки' },
            onChange: function () { console.log(LOG_PREFIX, 'toggle ->', Lampa.Storage.field('ai_dub_enabled')); }
        });
    } else {
        console.warn(LOG_PREFIX, 'Lampa.SettingsApi недоступен — плагин загружен слишком рано или это не та версия Lampa');
    }

    function dubEnabled() {
        return Lampa.Storage.field('ai_dub_enabled');
    }

    // ---------------------------------------------------------------
    // Парсинг субтитров: srt / vtt / ass -> [{start_ms, end_ms, text}]
    // ---------------------------------------------------------------
    function timeToMs(h, m, s, frac) {
        // frac может быть 2 знака (.cc, ass) или 3 (,mmm / .mmm, srt/vtt)
        var ms = frac.length === 2 ? parseInt(frac, 10) * 10 : parseInt(frac, 10);
        return ((parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)) * 1000) + ms;
    }

    function parseSrtVtt(text) {
        var cues = [];
        var blocks = text.replace(/\r/g, '').split(/\n\n+/);
        var re = /(\d+):(\d{2}):(\d{2})[.,](\d{2,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[.,](\d{2,3})/;
        blocks.forEach(function (block) {
            var lines = block.split('\n').filter(Boolean);
            for (var i = 0; i < lines.length; i++) {
                var m = re.exec(lines[i]);
                if (!m) continue;
                var start = timeToMs(m[1], m[2], m[3], m[4]);
                var end = timeToMs(m[5], m[6], m[7], m[8]);
                var textLines = lines.slice(i + 1);
                var cueText = textLines.join(' ')
                    .replace(/<[^>]+>/g, '')   // <font>, <b> и т.п.
                    .replace(/\{[^}]*\}/g, '') // ass-теги на всякий случай
                    .trim();
                if (cueText) cues.push({ start_ms: start, end_ms: end, text: cueText });
                break;
            }
        });
        return cues;
    }

    function parseAss(text) {
        var cues = [];
        var lines = text.replace(/\r/g, '').split('\n');
        var format = null;
        var section = '';
        var re = /(\d+):(\d{2}):(\d{2})\.(\d{2})/;
        lines.forEach(function (line) {
            var sectionMatch = /^\[([^\]]+)\]/.exec(line);
            if (sectionMatch) { section = sectionMatch[1].toLowerCase(); return; }
            // у .ass своя секция [V4+ Styles] тоже начинается с "Format:",
            // но с другим набором полей (22 шт. вместо 10 у [Events]) —
            // нужен именно формат из [Events], иначе индекс текста поедет
            // и все реплики будут молча отбрасываться как "неправильные"
            if (section === 'events' && /^Format:/i.test(line)) {
                format = line.replace(/^Format:\s*/i, '').split(',').map(function (s) { return s.trim(); });
                return;
            }
            if (!/^Dialogue:/i.test(line)) return;
            var rest = line.replace(/^Dialogue:\s*/i, '');
            var textIdx = format ? format.length - 1 : 9;
            var parts = rest.split(',');
            if (parts.length <= textIdx) return;
            var startStr = parts[1], endStr = parts[2];
            var rawText = parts.slice(textIdx).join(',');
            var sm = re.exec(startStr), em = re.exec(endStr);
            if (!sm || !em) return;
            var start = timeToMs(sm[1], sm[2], sm[3], sm[4]);
            var end = timeToMs(em[1], em[2], em[3], em[4]);
            var cueText = rawText
                .replace(/\{[^}]*\}/g, '')   // ass override-теги {\...}
                .replace(/\\N/g, ' ')
                .replace(/\\n/g, ' ')
                .trim();
            if (cueText) cues.push({ start_ms: start, end_ms: end, text: cueText });
        });
        return cues;
    }

    function parseSubtitles(url, text) {
        var lower = url.toLowerCase();
        var cues;
        if (lower.indexOf('.ass') !== -1 || /^\[script info\]/im.test(text)) {
            cues = parseAss(text);
        } else {
            cues = parseSrtVtt(text);
        }
        cues.sort(function (a, b) { return a.start_ms - b.start_ms; });
        return cues;
    }

    // ---------------------------------------------------------------
    // Fish Audio TTS: одна реплика за один POST-запрос
    // ---------------------------------------------------------------
    function synthOne(text, speed) {
        var body = {
            text: text,
            format: 'mp3',
            chunk_length: 300,
            latency: 'normal',
            reference_id: REFERENCE_ID
        };
        if (speed && speed !== 1) {
            body.prosody = { speed: Math.max(0.5, Math.min(2.0, speed)) };
        }
        return fetch(TTS_PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (resp) {
            if (!resp.ok) throw new Error('TTS proxy HTTP ' + resp.status);
            return resp.arrayBuffer();
        });
    }

    // ---------------------------------------------------------------
    // Контроллер дубляжа для одного сеанса воспроизведения
    // ---------------------------------------------------------------
    function DubController(video, cues) {
        this.video = video;
        this.cues = cues;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.state = cues.map(function () { return 'pending'; }); // pending|loading|ready|failed|played
        this.buffers = new Array(cues.length);
        this.sources = [];
        this.destroyed = false;
        // видео и пауза/перемотка отслеживаются ОПРОСОМ в tick(), а не через
        // addEventListener на конкретном узле — Lampa, судя по всему,
        // пересоздаёт <video> в процессе запуска воспроизведения, и любой
        // слушатель, повешенный на старый узел, тихо перестаёт стрелять
        // (currentTime у сохранённой ссылки застревал на 0, хотя в DOM
        // реальный элемент уже играл и currentTime у него рос).
        this.lastKnownMs = video.currentTime * 1000;
        this.ctxSuspended = video.paused;
        if (video.paused) this.ctx.suspend();
        this.activeWindows = []; // [{start_ms, end_ms}] — когда реально звучит синтезированная реплика
        this.ducked = false;
        this.seekSettleUntil = 0;
    }

    DubController.prototype.budgetMs = function (i) {
        var cue = this.cues[i];
        var next = this.cues[i + 1];
        return next ? (next.start_ms - cue.start_ms) : (cue.end_ms - cue.start_ms + 1000);
    };

    DubController.prototype.ensureSynthesized = function (i) {
        var self = this;
        if (this.state[i] !== 'pending') return;
        this.state[i] = 'loading';
        var cue = this.cues[i];
        console.log(LOG_PREFIX, 'синтезирую реплику', i, JSON.stringify(cue.text));

        synthOne(cue.text, 1).then(function (buf) {
            console.log(LOG_PREFIX, 'реплика', i, 'получена от Fish Audio,', buf.byteLength, 'байт');
            return self.ctx.decodeAudioData(buf.slice(0)).then(function (audioBuf) {
                var allowedMs = self.budgetMs(i) + OVERLAP_TOLERANCE_MS;
                var synthMs = audioBuf.duration * 1000;
                if (synthMs <= allowedMs) {
                    self.buffers[i] = audioBuf;
                    self.state[i] = 'ready';
                    console.log(LOG_PREFIX, 'реплика', i, 'готова, ' + synthMs.toFixed(0) + 'мс, без коррекции скорости');
                    return;
                }
                // не уложились даже с запасом на наложение — досинтезируем с ускорением
                var speed = synthMs / allowedMs;
                console.log(LOG_PREFIX, 'реплика', i, 'не укладывается (' + synthMs.toFixed(0) + 'мс из ' + allowedMs.toFixed(0) + 'мс), ускоряю в', speed.toFixed(2), 'раза');
                return synthOne(cue.text, speed).then(function (buf2) {
                    return self.ctx.decodeAudioData(buf2.slice(0));
                }).then(function (audioBuf2) {
                    self.buffers[i] = audioBuf2;
                    self.state[i] = 'ready';
                    console.log(LOG_PREFIX, 'реплика', i, 'готова после ускорения');
                });
            });
        }).catch(function (err) {
            console.warn(LOG_PREFIX, 'ошибка синтеза реплики', i, cue.text, err);
            self.state[i] = 'failed';
        });
    };

    DubController.prototype.scheduleReady = function () {
        var self = this;
        var nowVideoMs = this.video.currentTime * 1000;
        this.cues.forEach(function (cue, i) {
            if (self.state[i] !== 'ready') return;
            if (cue.start_ms < nowVideoMs - 500) { self.state[i] = 'played'; return; } // прозевали (перемотка вперёд)
            var delaySec = (cue.start_ms - nowVideoMs) / 1000;
            if (delaySec > (LOOKAHEAD_MS / 1000) + 1) return; // ещё рано планировать
            self.state[i] = 'played';
            var src = self.ctx.createBufferSource();
            src.buffer = self.buffers[i];
            src.connect(self.ctx.destination);
            var startAt = self.ctx.currentTime + Math.max(0, delaySec);
            src.start(startAt);
            self.sources.push(src);
            // окно, в которое реально звучит эта реплика — по нему приглушаем
            // оригинал, а не постоянно на всё время работы озвучки
            self.activeWindows.push({ start_ms: cue.start_ms, end_ms: cue.start_ms + self.buffers[i].duration * 1000 });
        });
    };

    DubController.prototype.updateDucking = function (nowVideoMs) {
        // чистим окна, которые уже прозвучали
        this.activeWindows = this.activeWindows.filter(function (w) { return w.end_ms >= nowVideoMs - 200; });
        var shouldDuck = this.activeWindows.some(function (w) { return nowVideoMs >= w.start_ms && nowVideoMs <= w.end_ms; });
        if (shouldDuck === this.ducked) return;
        this.ducked = shouldDuck;
        rampVolume(this.video, shouldDuck ? DUCK_VOLUME : 1, DUCK_RAMP_MS);
    };

    DubController.prototype.cancelScheduled = function () {
        this.sources.forEach(function (src) { try { src.stop(); } catch (e) {} });
        this.sources = [];
        for (var i = 0; i < this.state.length; i++) {
            if (this.state[i] === 'played') this.state[i] = this.buffers[i] ? 'ready' : 'pending';
        }
        this.activeWindows = [];
        if (this.ducked) {
            this.ducked = false;
            rampVolume(this.video, 1, DUCK_RAMP_MS);
        }
    };

    DubController.prototype.tick = function () {
        if (this.destroyed) return;

        // всегда спрашиваем актуальный <video> заново — см. комментарий
        // в конструкторе про пересоздание элемента самой Lampa
        var liveVideo = Lampa.PlayerVideo.video();
        if (liveVideo) this.video = liveVideo;
        var video = this.video;
        var nowVideoMs = video.currentTime * 1000;

        var advancingMs = nowVideoMs - this.lastKnownMs;
        var isSeek = Math.abs(advancingMs - 1000) > 2500; // большой скачок — перемотка
        // буферизация: видео.paused остаётся false, когда браузер просто
        // ждёт данных (readyState/"waiting") — currentTime при этом почти
        // не двигается. Раньше мы следили только за paused, и AudioContext
        // продолжал идти своим ходом, играя реплики по расписанию, пока
        // зависшее видео стояло на месте ("озвучка на несколько фраз вперёд").
        var isStalled = !video.paused && !isSeek && advancingMs < 200;
        var shouldSuspend = video.paused || isStalled;

        if (shouldSuspend !== this.ctxSuspended) {
            this.ctxSuspended = shouldSuspend;
            if (shouldSuspend) {
                this.ctx.suspend();
                console.log(LOG_PREFIX, video.paused ? 'видео на паузе — глушу AudioContext' : 'видео зависло на буферизации — глушу AudioContext');
            } else {
                this.ctx.resume();
                console.log(LOG_PREFIX, 'видео продолжилось — возобновляю AudioContext');
            }
        }

        // перемотка — сбрасываем всё запланированное, т.к. тайминги больше не актуальны.
        // Дальше даём позиции "устояться" (SEEK_SETTLE_MS): после перемотки
        // видео/TorrServer может ещё пару тиков дёргаться (буферизация на
        // новом месте), и если планировать реплики сразу по нестабильному
        // currentTime — получается "волна" из нескольких реплик почти
        // одновременно, невпопад. Планирование заново включаем только
        // когда currentTime перестаёт скакать.
        if (isSeek) {
            console.log(LOG_PREFIX, 'похоже на перемотку (' + (this.lastKnownMs / 1000).toFixed(1) + 'с -> ' + (nowVideoMs / 1000).toFixed(1) + 'с), сбрасываю запланированное и жду стабилизации');
            this.cancelScheduled();
            this.seekSettleUntil = Date.now() + SEEK_SETTLE_MS;
        }
        this.lastKnownMs = nowVideoMs;

        if (this.seekSettleUntil && Date.now() < this.seekSettleUntil) {
            return; // ждём, пока позиция устаканится, ничего не планируем в этот тик
        }
        this.seekSettleUntil = 0;

        var self = this;
        var inWindow = 0;
        this.cues.forEach(function (cue, i) {
            if (cue.start_ms - nowVideoMs <= LOOKAHEAD_MS && cue.start_ms >= nowVideoMs - 2000) {
                inWindow++;
                self.ensureSynthesized(i);
            }
        });
        this._tickCount = (this._tickCount || 0) + 1;
        if (this._tickCount % 5 === 1) {
            console.log(LOG_PREFIX, 'tick, видео на', (nowVideoMs / 1000).toFixed(1) + 'с, реплик в окне поиска:', inWindow);
        }
        this.scheduleReady();
        this.updateDucking(nowVideoMs);
    };

    DubController.prototype.destroy = function () {
        this.destroyed = true;
        this.sources.forEach(function (src) { try { src.stop(); } catch (e) {} });
        this.sources = [];
        try { this.ctx.close(); } catch (e) {}
    };

    // ---------------------------------------------------------------
    // Подключение к плееру
    // ---------------------------------------------------------------
    var current = null; // { controller, timer }
    // Lampa шлёт 'start' дважды подряд (предзагрузка + реальный запуск).
    // Каждый вызов startDub() получает свой номер поколения; если пока
    // старый fetch() субтитров ещё летит (например, завис на холодном
    // старте торрента) стартовал более новый запуск — старый, долетев,
    // не должен затирать уже рабочий current своим устаревшим состоянием.
    var generation = 0;

    function stopCurrent() {
        generation++; // любой ещё летящий fetch() субтитров из прошлого запуска теперь считается устаревшим
        if (!current) return;
        if (current.timer) clearInterval(current.timer);
        if (current.controller) current.controller.destroy();
        try { Lampa.PlayerVideo.volume(1); } catch (e) {}
        current = null;
    }

    function startDub(subtitleUrl) {
        stopCurrent();
        var video = Lampa.PlayerVideo.video();
        if (!video || !subtitleUrl) return;

        var myGeneration = generation;
        var startedAt = Date.now();

        // холодный торрент: TorrServer может отдавать субтитровый файл
        // отдельно от видео (свой приоритет пиров/кусков) и молчать до
        // ~90с при первом обращении — печатаем "жду ещё" вместо тишины,
        // чтобы не выглядело зависшим, и прекращаем ждать через SUB_FETCH_TIMEOUT_MS.
        var heartbeat = setInterval(function () {
            if (myGeneration !== generation) { clearInterval(heartbeat); return; }
            console.log(LOG_PREFIX, 'всё ещё жду субтитры от TorrServer (' + ((Date.now() - startedAt) / 1000).toFixed(0) + 'с) — это нормально для только что открытого торрента, ждём пиров');
        }, 10000);
        var abortController = new AbortController();
        var timeoutTimer = setTimeout(function () {
            console.warn(LOG_PREFIX, 'TorrServer не отдал субтитры за ' + (SUB_FETCH_TIMEOUT_MS / 1000) + 'с, обрываю запрос и сдаюсь на этот запуск');
            abortController.abort();
        }, SUB_FETCH_TIMEOUT_MS);

        fetch(subtitleUrl, { signal: abortController.signal }).then(function (r) {
            console.log(LOG_PREFIX, 'ответ на запрос субтитров:', r.status, r.ok, r.headers.get('content-type'), r.headers.get('content-length'));
            return r.text();
        }).then(function (text) {
            clearInterval(heartbeat);
            clearTimeout(timeoutTimer);
            if (myGeneration !== generation) {
                console.log(LOG_PREFIX, 'этот запуск (#' + myGeneration + ') устарел, за это время стартовал #' + generation + ' — игнорирую результат');
                return;
            }
            console.log(LOG_PREFIX, 'текст субтитров, длина:', text.length, 'превью:', JSON.stringify(text.slice(0, 200)));
            var cues = parseSubtitles(subtitleUrl, text);
            console.log(LOG_PREFIX, 'распознано реплик:', cues.length);
            if (!cues.length) {
                console.warn('[ai-dub] субтитры пустые или не распознаны:', subtitleUrl);
                return;
            }
            // ещё раз проверяем поколение — пока парсили, мог подоспеть новый старт
            if (myGeneration !== generation) return;
            // pause/play/перемотку контроллер отслеживает сам опросом в
            // tick() (см. DubController) — DOM-события тут не нужны и
            // ненадёжны, раз Lampa пересоздаёт <video> в процессе запуска.
            var liveVideo = Lampa.PlayerVideo.video() || video;
            var controller = new DubController(liveVideo, cues);
            var timer = setInterval(function () { controller.tick(); }, 1000);
            current = { controller: controller, timer: timer };
            // громкость приглушается/восстанавливается динамически из
            // DubController.updateDucking() только на время реального
            // звучания реплики, не на всё время работы озвучки
            controller.tick();
        }).catch(function (err) {
            clearInterval(heartbeat);
            clearTimeout(timeoutTimer);
            if (err && err.name === 'AbortError') {
                console.warn(LOG_PREFIX, 'не дождались субтитров от TorrServer за ' + (SUB_FETCH_TIMEOUT_MS / 1000) + 'с — торрент слишком холодный или пиров нет');
            } else {
                console.warn(LOG_PREFIX, 'не удалось загрузить субтитры', err);
            }
        });
    }

    // -----------------------------------------------------------------
    // Резервный путь: для торрент-источников (TorrServer) Lampa часто НЕ
    // заполняет data.subtitles — субтитровый файл в такой раздаче просто
    // ещё один файл торрента (например, .ass рядом с .mkv), а не отдельно
    // объявленная "дорожка". Спрашиваем список файлов у самого TorrServer
    // (тот же хост, что отдаёт видео) и ищем .srt/.ass/.vtt в той же папке.
    // -----------------------------------------------------------------
    var SUB_EXT_RE = /\.(ass|ssa|srt|vtt)$/i;

    function findTorrserverSubtitleUrl(videoUrl) {
        var m = /^(https?:\/\/[^/]+)\/stream\/[^?]*\?link=([0-9a-f]+)/i.exec(videoUrl || '');
        if (!m) return Promise.resolve(null);
        var origin = m[1], hash = m[2];

        return fetch(origin + '/torrents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'get', hash: hash })
        }).then(function (r) { return r.json(); }).then(function (torrent) {
            var files = (torrent && torrent.file_stats) || [];
            var videoPath = decodeURIComponent(videoUrl.split('/stream/')[1].split('?')[0]);
            var videoDir = videoPath.substring(0, videoPath.lastIndexOf('/'));
            var candidate = files.find(function (f) {
                return SUB_EXT_RE.test(f.path) && f.path.substring(0, f.path.lastIndexOf('/')) === videoDir;
            }) || files.find(function (f) { return SUB_EXT_RE.test(f.path); }); // не нашли рядом — берём любой сабовый файл в раздаче
            if (!candidate) return null;
            var basename = candidate.path.split('/').pop();
            return origin + '/stream/' + encodeURIComponent(basename) + '?link=' + hash + '&index=' + candidate.id + '&play';
        }).catch(function (err) {
            console.warn(LOG_PREFIX, 'не удалось опросить TorrServer на предмет субтитров', err);
            return null;
        });
    }

    Lampa.Player.listener.follow('start', function (data) {
        console.log(LOG_PREFIX, 'player start, enabled =', dubEnabled(), 'data =', data);
        if (!dubEnabled()) { console.log(LOG_PREFIX, 'выключено в настройках — выходим'); return; }

        var videoUrl = (data && data.url) || (Lampa.PlayerVideo.video() && Lampa.PlayerVideo.video().currentSrc) || '';

        // Для TorrServer-источников всегда переспрашиваем АКТУАЛЬНЫЙ индекс
        // файла субтитров напрямую у TorrServer, а не берём снэпшот из
        // data.subtitles: на самом первом открытии свежедобавленного
        // торрента метаданные (список файлов/индексы) могли ещё не до
        // конца устояться в момент события 'start', и Lampa могла отдать
        // ссылку со "старым"/неверным index= — TorrServer на такой запрос
        // просто никогда не ответит (не 404, а вечное ожидание). Именно
        // это выглядело как "зависает при первом запуске, помогает только
        // быстрый перезапуск плеера".
        if (/\/stream\/[^?]*\?link=[0-9a-f]+/i.test(videoUrl)) {
            console.log(LOG_PREFIX, 'источник — TorrServer, спрашиваю свежий индекс субтитров напрямую:', videoUrl);
            findTorrserverSubtitleUrl(videoUrl).then(function (url) {
                if (url) { console.log(LOG_PREFIX, 'нашёл субтитры через TorrServer:', url); startDub(url); return; }
                console.warn(LOG_PREFIX, 'в этой раздаче не нашлось файла субтитров (.ass/.srt/.vtt) через TorrServer, пробую data.subtitles как запасной вариант');
                var subs = (data && data.subtitles) || [];
                if (subs.length) startDub(subs[0].url);
                else console.warn(LOG_PREFIX, 'субтитров нигде не нашлось');
            });
            return;
        }

        var subs = (data && data.subtitles) || [];
        if (!subs.length) {
            var pd = Lampa.Player.playdata && Lampa.Player.playdata();
            subs = (pd && pd.subtitles) || [];
        }
        if (subs.length) {
            console.log(LOG_PREFIX, 'запускаю озвучку по дорожке из data.subtitles:', subs[0].url);
            startDub(subs[0].url);
        } else {
            console.warn(LOG_PREFIX, 'у этого видео нет субтитровой дорожки');
        }
    });

    Lampa.Player.listener.follow('destroy', function () {
        stopCurrent();
    });

    console.log(LOG_PREFIX, 'плагин загружен');
})();

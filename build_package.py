"""Сборка пакета для встраивания FORMYLA Meet в Flask-сайт FORMYLA.net.
Генерирует static/meet/meet.css (всё CSS вложено в #fm через CSS Nesting), копирует JS,
шаблон templates/meet.html и фрагменты для app.py / misc.html."""
import re, shutil, pathlib, zipfile

ROOT = pathlib.Path(__file__).parent
OUT = ROOT / 'formyla_package'
if OUT.exists(): shutil.rmtree(OUT)
(OUT / 'static' / 'meet').mkdir(parents=True)
(OUT / 'templates').mkdir(parents=True)

def strip_comments(css): return re.sub(r'/\*.*?\*/', '', css, flags=re.S)

def split_top(css):
    """Разбить CSS на верхнеуровневые блоки (селектор + тело с учётом вложенности)."""
    out, i, n = [], 0, len(css)
    while i < n:
        j = css.find('{', i)
        if j < 0: break
        depth, k = 0, j
        while k < n:
            if css[k] == '{': depth += 1
            elif css[k] == '}':
                depth -= 1
                if depth == 0: break
            k += 1
        out.append((css[i:j].strip(), css[j+1:k]))
        i = k + 1
    return out

def important_colors(body):
    # color: … → color: … !important (только свойство color, не background-color)
    return re.sub(r'(?<![-\w])color\s*:\s*([^;!}]+?)\s*(;|$|(?=}))', lambda m: f'color: {m.group(1).strip()} !important{m.group(2) if m.group(2)==";" else ";"}', body)

def scope(css):
    css = strip_comments(css)
    hoisted, nested, globals_ = [], [], []
    for sel, body in split_top(css):
        if sel.startswith('@keyframes'):
            hoisted.append(f'{sel} {{{body}}}')
        elif sel.startswith('@media'):
            inner = []
            for s2, b2 in split_top(body):
                if s2.startswith('body.in-meeting'):
                    globals_.append(f'{sel} {{ {s2.replace("body.in-meeting", "body.in-meeting #fm", 1)} {{{important_colors(b2)}}} }}')
                elif s2 in ('html', 'body', 'html, body') or s2.startswith('*'):
                    continue
                else:
                    inner.append(f'  {s2} {{{important_colors(b2)}}}')
            if inner: nested.append(f'{sel} {{\n' + '\n'.join(inner) + '\n}')
        elif sel == ':root':
            nested.append(f'& {{{body}}}')
        elif sel in ('html', 'body', 'html, body') or sel.startswith('*'):
            continue
        elif sel.startswith('body.in-meeting'):
            if sel == 'body.in-meeting': globals_.append(f'body.in-meeting {{{body}}}')
            else: globals_.append(f'{sel.replace("body.in-meeting", "body.in-meeting #fm", 1)} {{{important_colors(body)}}}')
        elif sel.startswith(':focus-visible'):
            nested.append(f'*:focus-visible {{{body}}}')
        else:
            nested.append(f'{sel} {{{important_colors(body)}}}')
    return hoisted, nested, globals_

base_css = (ROOT / 'base.css').read_text()
style_css = (ROOT / 'style.css').read_text()
h1, n1, g1 = scope(base_css)
h2, n2, g2 = scope(style_css)

reset = '''
/* Сброс глобальных стилей FORMYLA.net внутри раздела */
& { font-family: var(--font); color: var(--text-main) !important; line-height: 1.55; -webkit-font-smoothing: antialiased; caret-color: auto; min-height: 60vh; }
& *, & *::before, & *::after { box-sizing: border-box; }
& button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font: inherit; color: inherit !important; text-align: center; }
& button:hover { transform: none; opacity: 1; }
& input, & select, & textarea { width: auto; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; caret-color: #38ef7d; font: inherit; color: inherit !important; }
& input[type=checkbox], & input[type=radio] { width: 16px; height: 16px; accent-color: #8b5cf6; }
& label { display: inline-block; min-width: 0; gap: 0; font-size: inherit; font-weight: inherit; color: inherit !important; }
& a { color: inherit; text-decoration: none; }
& h1, & h2, & h3, & h4, & p { margin: 0; }
& ul, & ol { margin: 0; padding: 0; list-style: none; }
& img, & svg, & video, & canvas { display: block; max-width: 100%; }
'''

meet_css = '/* FORMYLA Meet — стили раздела. Все правила вложены в #fm (CSS Nesting), чтобы не конфликтовать со стилями сайта. */\n'
meet_css += '\n'.join(h1 + h2) + '\n\n'
meet_css += '#fm {\n' + reset + '\n' + '\n'.join(n1 + n2) + '\n}\n\n'
meet_css += '/* Правила уровня body */\n' + '\n'.join(g1 + g2) + '\n'
(OUT / 'static' / 'meet' / 'meet.css').write_text(meet_css)

for js in ['icons.js', 'whiteboard.js', 'sim.js', 'meeting.js', 'app.js']:
    shutil.copy(ROOT / js, OUT / 'static' / 'meet' / js)

# ---------- шаблон ----------
index = (ROOT / 'index.html').read_text()
body = index[index.index('<div id="fm">'):index.index('</div><!-- /#fm -->') + len('</div><!-- /#fm -->')]
template = '''{% extends "base.html" %}
{% block title %}Видеовстречи — FORMYLA.net{% endblock %}
{% block meta_description %}Видеовстречи FORMYLA.net: HD-видео, общая доска, чат, демонстрация экрана, сессионные залы, опросы, записи и субтитры.{% endblock %}
{% block extra_css %}
<link rel="preconnect" href="https://api.fontshare.com">
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{{ url_for('static', filename='meet/meet.css') }}?v={{ asset_version }}">
<style>
    /* На странице видеовстреч прячем плавающие виджеты сайта, чтобы не перекрывали комнату */
    #tutorBtn, #cf-pip-overlay { display: none !important; }
    .main { padding: 0 0 40px; }
</style>
{% endblock %}

{% block content %}
''' + body + '''
{% endblock %}

{% block extra_js %}
<script>
  // Имя пользователя FORMYLA.net для встреч (гость — «Гость»)
  window.FM_USER = {
    name: {{ ((current_user.nickname or current_user.name or 'Гость') if current_user.is_authenticated else 'Гость') | tojson }},
    email: {{ (current_user.email if current_user.is_authenticated and current_user.email else '') | tojson }}
  };
</script>
<script src="{{ url_for('static', filename='meet/icons.js') }}?v={{ asset_version }}"></script>
<script src="{{ url_for('static', filename='meet/whiteboard.js') }}?v={{ asset_version }}"></script>
<script src="{{ url_for('static', filename='meet/sim.js') }}?v={{ asset_version }}"></script>
<script src="{{ url_for('static', filename='meet/meeting.js') }}?v={{ asset_version }}"></script>
<script src="{{ url_for('static', filename='meet/app.js') }}?v={{ asset_version }}"></script>
{% endblock %}
'''
(OUT / 'templates' / 'meet.html').write_text(template)

# ---------- фрагменты ----------
(OUT / 'SNIPPET_app_py.txt').write_text('''# ==== Видеовстречи FORMYLA Meet ====
# Вставить в app.py рядом с маршрутом /misc (например, сразу после def misc_page()).

@app.route('/meet')
def meet_page():
    """Раздел «Видеовстречи» (FORMYLA Meet): встречи, доска, чат, записи."""
    return render_template('meet.html')
''')

(OUT / 'SNIPPET_misc_html.txt').write_text('''<!-- ==== Видеовстречи FORMYLA Meet ====
     Вставить в templates/misc.html внутри группы «🛠️ Инструменты»
     (например, сразу после строки .misc-row с «💡 Банк неточностей»). -->
<div class="misc-row">
    <a href="/meet" class="misc-link"><span class="misc-link-label">🎥 Видеовстречи</span><span class="misc-link-desc">Встречи, общая доска, чат, залы и записи</span></a>
    <button class="pin-btn" data-pin-id="meet" data-pin-label="🎥 Видеовстречи" data-pin-href="/meet" data-pin-desc="Встречи, общая доска, чат, залы и записи" title="На главную">📌</button>
</div>
''')

(OUT / 'README.md').write_text('''# FORMYLA Meet — раздел «Видеовстречи» для FORMYLA.net

Пакет встраивает приложение видеовстреч (копия Zoom в стиле FORMYLA.net) как раздел сайта.
Собственной шапки у раздела нет — используется шапка сайта из `base.html`.

## Состав

| Файл | Куда положить |
|---|---|
| `templates/meet.html` | `templates/meet.html` (новый файл, наследует `base.html`) |
| `static/meet/meet.css` | `static/meet/meet.css` |
| `static/meet/icons.js`, `whiteboard.js`, `sim.js`, `meeting.js`, `app.js` | `static/meet/` |
| `SNIPPET_app_py.txt` | маршрут `/meet` — вставить в `app.py` после `misc_page()` |
| `SNIPPET_misc_html.txt` | строка раздела — вставить в `templates/misc.html`, группа «🛠️ Инструменты» |

## Установка (3 шага)

1. Скопировать папку `static/meet/` и файл `templates/meet.html` в проект.
2. Вставить содержимое `SNIPPET_app_py.txt` в `app.py` (рядом с `@app.route('/misc')`).
3. Вставить содержимое `SNIPPET_misc_html.txt` в `templates/misc.html`.

Проверка: открыть `/misc` → «🎥 Видеовстречи» → `/meet`. Нажать «Новая встреча» → «Начать встречу»:
на экране подготовки появится блок «Нужен доступ к камере и микрофону» и запрос браузера.

## Важно

- Доступ к камере и микрофону браузер даёт только по HTTPS (на formyla.net так и есть) и только по действию пользователя —
  запрос идёт при открытии экрана подготовки и по кнопке «Разрешить доступ».
- Все стили вложены в `#fm { … }` (CSS Nesting, Chrome 120+, Safari 17.2+, Firefox 117+) и не трогают остальной сайт;
  глобальный `button { background: gradient; color: #fff !important }` сайта внутри раздела сброшен.
- Комната встречи открывается поверх всей страницы (`z-index: 5000`) и скрывает шапку, пока идёт встреча.
- Участники, их сообщения и реакции пока симулируются. Для настоящих звонков нужно подключить сигналинг —
  в проекте уже есть `/api/wb_call/*` и `static/js/wb_signalling.js` (используются страницами `/call` и `/conference`).
- Записи и настройки хранятся в памяти страницы (без localStorage); при перезагрузке очищаются.

## Промпт для Roo

```
Встрой раздел «Видеовстречи» (FORMYLA Meet) в проект FORMYLA:
1. Скопируй из пакета formyla_meet_package: папку static/meet/ → static/meet/, файл templates/meet.html → templates/meet.html.
2. В app.py сразу после функции misc_page() добавь маршрут из SNIPPET_app_py.txt (GET /meet → render_template('meet.html')).
3. В templates/misc.html в группу «🛠️ Инструменты» после строки с «💡 Банк неточностей» вставь .misc-row из SNIPPET_misc_html.txt.
4. Ничего больше не меняй: base.html, nav.js, стили сайта и другие шаблоны не трогать.
5. Перед коммитом покажи список добавленных и изменённых файлов (только 8 файлов: 6 в static/meet, templates/meet.html, app.py, templates/misc.html — итого 9 путей). Убедись, что в коммит не попали .env, дампы и логи.
6. Проверь: flask запускается, GET /meet возвращает 200, на /misc есть ссылка «🎥 Видеовстречи», в консоли браузера на /meet нет ошибок.
```
''')

with zipfile.ZipFile(ROOT / 'formyla_meet_package.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for p in OUT.rglob('*'):
        if p.is_file(): z.write(p, p.relative_to(OUT))
print('ok', sum(1 for _ in OUT.rglob('*') if _.is_file()), 'files')

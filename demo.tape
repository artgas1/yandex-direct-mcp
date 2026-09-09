# Живая запись сервера: тейп лежит в репозитории и пересобирается командой
#   npm run demo:record   (нужен vhs — brew install vhs)
#
# Всё, что видно на записи, приходит из настоящего обмена по JSON-RPC. Левая
# колонка — тело ответа, разобранное голым JSON.parse, то есть так, как его
# получил бы обычный клиент; правая — то, что вернул сервер. Токен и сеть не
# нужны: запросы уводятся на локальную заглушку, значения в ней синтетические.
#
# Длительность держим под пятью секундами: зацикленная анимация дольше пяти
# секунд рядом с другим содержимым нарушает WCAG 2.2 SC 2.2.2 (уровень A), а
# механизма паузы в README нет. Зацикливание снимается после записи —
# tools/gif-play-once.mjs.

Output assets/demo.gif

Set Shell zsh
Set FontSize 18
Set Width 1320
Set Height 330  # под содержимое: при 380 внизу пустота, при 290 уезжает строка команды
Set Padding 22
Set TypingSpeed 35ms
Set Theme { "background": "#16191d", "foreground": "#e4e7ea", "cursor": "#fc3f1d", "black": "#16191d", "red": "#fc3f1d", "green": "#4fae83", "yellow": "#d8a657", "blue": "#7fa6dd", "magenta": "#c98bdb", "cyan": "#6fb2b8", "white": "#e4e7ea", "brightBlack": "#98a1ab", "brightRed": "#fc3f1d", "brightGreen": "#4fae83", "brightYellow": "#d8a657", "brightBlue": "#7fa6dd", "brightMagenta": "#c98bdb", "brightCyan": "#6fb2b8", "brightWhite": "#ffffff" }

Type "node tools/demo.mjs"
Sleep 250ms
Enter
Sleep 2.8s

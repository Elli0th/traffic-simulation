import os, math
OUT = 'docs/gestures'
BG, CARD, TEXT, DIM, ACC, RED, GREEN, HAND, AMBER = '#0b0d11', '#151920', '#e9ecef', '#8a94a3', '#5ad1ff', '#ff3b5c', '#00e5a3', '#f1f3f5', '#ffb020'
FONT = "font-family=\"-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif\""

def hand(x, y, rot=0, opacity=1, scale=1):
    # Seen from above, the tip of the index finger at (x, y), the arm leaving downwards.
    s = f'stroke="{CARD}" stroke-width="4"'
    return f'''<g transform="translate({x} {y}) rotate({rot}) scale({scale})" opacity="{opacity}" fill="{HAND}">
  <rect x="-16" y="150" width="62" height="120" rx="20" {s}/>
  <rect x="-58" y="92" width="26" height="74" rx="13" transform="rotate(-28 -45 129)" {s}/>
  <rect x="-32" y="78" width="88" height="98" rx="26" {s}/>
  <rect x="12" y="52" width="23" height="62" rx="11.5" {s}/>
  <rect x="33" y="62" width="22" height="58" rx="11" {s}/>
  <rect x="-13" y="-12" width="26" height="118" rx="13" {s}/>
</g>'''

def arrow(x1, y1, x2, y2, color=ACC, w=6):
    a = math.atan2(y2 - y1, x2 - x1); h = 20
    bx, by = x2 - math.cos(a) * h, y2 - math.sin(a) * h
    px, py = -math.sin(a) * h * 0.55, math.cos(a) * h * 0.55
    return (f'<line x1="{x1}" y1="{y1}" x2="{bx:.1f}" y2="{by:.1f}" stroke="{color}" stroke-width="{w}" stroke-linecap="round"/>'
            f'<polygon points="{x2},{y2} {bx+px:.1f},{by+py:.1f} {bx-px:.1f},{by-py:.1f}" fill="{color}"/>')

def arc(cx, cy, r, share, color='#ffffff', w=7):
    a = -math.pi / 2 + share * 2 * math.pi
    x, y = cx + r * math.cos(a), cy + r * math.sin(a)
    return (f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="{w}"/>'
            f'<path d="M {cx} {cy - r} A {r} {r} 0 {1 if share > 0.5 else 0} 1 {x:.1f} {y:.1f}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linecap="round"/>')

def ripples(cx, cy, color):
    return ''.join(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{color}" stroke-width="5" opacity="{o}"/>' for r, o in [(20, 1), (38, 0.6), (58, 0.3)])

def label(x, y, text, color=DIM, size=20, anchor='middle', weight=500):
    return f'<text x="{x}" y="{y}" {FONT} font-size="{size}" font-weight="{weight}" fill="{color}" text-anchor="{anchor}">{text}</text>'

def streets(shift=0):
    # A scrap of map: a few streets, to show what moves.
    g = f'<g stroke="#39414e" stroke-width="14" stroke-linecap="round" fill="none" transform="translate({shift} 0)">'
    g += '<path d="M 150 190 L 650 250"/><path d="M 180 400 L 640 360"/><path d="M 300 130 L 330 450"/><path d="M 520 140 L 480 450"/></g>'
    return g

CARDS = []
def card(slug, where, title, lines, art):
    CARDS.append((slug, where, title, lines, art))

card('tap', 'Outbreak game', 'Tap', ['Touch the table for half a second, then lift.', 'Presses the button there, or plays on the map there.'],
     ripples(400, 190, RED) + hand(400, 190) + arrow(520, 150, 520, 210, DIM, 5) + arrow(560, 210, 560, 150, DIM, 5) + label(540, 245, 'down, up'))
card('hold', 'Outbreak game', 'Hold still', ['Keep a finger still for about a second. No need to lift.', 'A ring fills, then it clicks: the same as a tap.'],
     arc(400, 190, 44, 0.72) + hand(400, 190) + label(530, 198, '1 s', TEXT, 30, 'start', 700))
card('piece', 'Outbreak game', 'Put a piece down', ['Stand a piece on your own half of the map.', 'It plays there once. Lift it and put it back to play again.'],
     arc(400, 290, 78, 0.72) + f'<circle cx="400" cy="290" r="52" fill="{GREEN}"/><circle cx="400" cy="290" r="34" fill="none" stroke="{CARD}" stroke-width="5" opacity="0.5"/>'
     + arrow(400, 130, 400, 195, DIM, 5))
card('rest', 'Outbreak game', 'Resting hand or arm', ['Anything wider than a few fingers is ignored,', 'so leaning on the table presses nothing.'],
     f'<g opacity="0.55"><rect x="150" y="262" width="330" height="96" rx="48" fill="{HAND}" transform="rotate(-12 315 310)"/></g>'
     + f'<circle cx="600" cy="170" r="46" fill="none" stroke="{DIM}" stroke-width="8"/><line x1="568" y1="202" x2="632" y2="138" stroke="{DIM}" stroke-width="8" stroke-linecap="round"/>'
     + label(600, 252, 'nothing happens', DIM, 22))
card('zoom-buttons', 'Outbreak game', 'Zoom with the buttons', ['Tap +, − or Whole map at the top of your panel.', 'The map is not dragged by hand in the game.'],
     ''.join(f'<rect x="{x}" y="150" width="{w}" height="76" rx="14" fill="#1c222b" stroke="{st}" stroke-width="3"/>' + label(x + w / 2, 200, t, TEXT, 34, 'middle', 600)
             for x, w, t, st in [(190, 90, '+', ACC), (300, 90, '−', '#39414e'), (410, 200, 'Whole map', '#39414e')])
     + hand(262, 216, 0, 1, 0.8))
card('drag', 'Traffic view', 'Drag with one hand', ['Slide one hand across the table.', 'The map follows it.'],
     streets(30) + hand(300, 230, 0, 0.25) + hand(470, 230) + arrow(290, 150, 470, 150))
card('zoom-in', 'Traffic view', 'Spread two hands', ['Move two hands apart.', 'The map zooms in, around the point between them.'],
     hand(250, 210, -18) + hand(550, 210, 18) + arrow(360, 190, 300, 190) + arrow(440, 190, 500, 190))
card('zoom-out', 'Traffic view', 'Bring two hands together', ['Move two hands towards each other.', 'The map zooms out.'],
     hand(230, 210, -18) + hand(570, 210, 18) + arrow(290, 190, 370, 190) + arrow(510, 190, 430, 190))
card('close-street', 'Traffic view', 'Put an object on a street', ['Anything that stands still for a second closes the street', 'under it. Traffic finds another way. Lift it to reopen.'],
     streets() + f'<path d="M 245 201 L 420 222" stroke="{RED}" stroke-width="20" stroke-linecap="round" opacity="0.75"/>'
     + f'<circle cx="332" cy="212" r="46" fill="{RED}" fill-opacity="0.2" stroke="{RED}" stroke-width="5"/><circle cx="332" cy="212" r="26" fill="{AMBER}"/>'
     + label(332, 300, 'closed', RED, 22, 'middle', 700))

def inner(where, title, lines, art):
    tag = RED if where == 'Outbreak game' else ACC
    out = f'<rect width="800" height="620" rx="28" fill="{CARD}"/>'
    out += f'<rect x="40" y="34" width="{len(where) * 13.2 + 30:.0f}" height="34" rx="17" fill="{tag}" fill-opacity="0.16"/>'
    out += label(54, 58, where.upper(), tag, 17, 'start', 700).replace('<text', '<text letter-spacing="1.5"')
    out += label(40, 118, title, TEXT, 44, 'start', 700)
    out += f'<g transform="translate(0 110)"><clipPath id="c"><rect x="20" y="20" width="760" height="380"/></clipPath><g clip-path="url(#c)">{art}</g></g>'
    out += f'<line x1="40" y1="516" x2="760" y2="516" stroke="#ffffff" stroke-opacity="0.1" stroke-width="2"/>'
    for k, line in enumerate(lines):
        out += label(40, 556 + k * 32, line, TEXT if k == 0 else DIM, 23, 'start', 500)
    return out

head = '<?xml version="1.0" encoding="UTF-8"?>\n'
for slug, where, title, lines, art in CARDS:
    svg = f'{head}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 620" width="1600" height="1240">{inner(where, title, lines, art)}</svg>\n'
    open(os.path.join(OUT, f'{slug}.svg'), 'w', encoding='utf-8').write(svg)

cols, gap = 3, 30
rows = math.ceil(len(CARDS) / cols)
W, H = cols * 800 + (cols + 1) * gap, rows * 620 + (rows + 1) * gap + 110
sheet = f'{head}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}"><rect width="{W}" height="{H}" fill="{BG}"/>'
sheet += label(gap + 10, 88, 'Hands on the table: what each gesture does', TEXT, 54, 'start', 700)
for k, (slug, where, title, lines, art) in enumerate(CARDS):
    x, y = gap + (k % cols) * (800 + gap), 110 + gap + (k // cols) * (620 + gap)
    body = inner(where, title, lines, art).replace('id="c"', f'id="c{k}"').replace('url(#c)', f'url(#c{k})')
    sheet += f'<svg x="{x}" y="{y}" width="800" height="620" viewBox="0 0 800 620">{body}</svg>'
sheet += '</svg>\n'
open(os.path.join(OUT, 'all-gestures.svg'), 'w', encoding='utf-8').write(sheet)
print(len(CARDS), 'cards', W, H)

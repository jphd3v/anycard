import os

# Configuration (Standard Brescia Deck Specs)
WIDTH = 159
HEIGHT = 319
CORNER_RADIUS = 12
MARGIN = 10
PAPER_COLOR = "#f2f2f2"
STROKE_COLOR = "#000000"

def create_better_joker(filename, main_color):
    # FIXED: Clean string with NO comments inside
    # This draws the 3-pointed floppy Jester hat
    hat_path = (
        "M 50 130 "
        "C 20 130, 10 90, 25 80 "
        "C 40 95, 55 115, 65 115 "
        "C 70 80, 75 50, 80 50 "
        "C 85 50, 90 80, 95 115 "
        "C 105 115, 120 95, 135 80 "
        "C 150 90, 140 130, 110 130 "
        "Q 80 145, 50 130 Z"
    )

    # 5-pointed Star Points
    star_points = "80,240 84,252 96,252 86,260 90,272 80,264 70,272 74,260 64,252 76,252"

    svg_content = f"""<svg width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <!-- 1. Card Base -->
      <rect x="0.5" y="0.5" width="{WIDTH-1}" height="{HEIGHT-1}" rx="{CORNER_RADIUS}" ry="{CORNER_RADIUS}" 
            fill="{PAPER_COLOR}" stroke="{STROKE_COLOR}" stroke-width="1" />

      <!-- 2. Inner Frame -->
      <rect x="{MARGIN}" y="{MARGIN}" width="{WIDTH - (MARGIN*2)}" height="{HEIGHT - (MARGIN*2)}" rx="{CORNER_RADIUS/2}" ry="{CORNER_RADIUS/2}" 
            fill="none" stroke="{STROKE_COLOR}" stroke-width="1" />

      <!-- 3. Corner Indices (J) -->
      <text x="22" y="35" font-family="Times New Roman, serif" font-size="22" font-weight="bold" fill="{main_color}" text-anchor="middle">J</text>
      <text x="{WIDTH-22}" y="{HEIGHT-35}" font-family="Times New Roman, serif" font-size="22" font-weight="bold" fill="{main_color}" text-anchor="middle" transform="rotate(180, {WIDTH-22}, {HEIGHT-35})">J</text>

      <!-- 4. Central Art -->
      <g transform="translate(0, 10)">
          
          <!-- The Hat Shape -->
          <path d="{hat_path}" fill="{main_color}" stroke="black" stroke-width="1.5" />
          
          <!-- The Bells (Gold circles at the tips of the tails) -->
          <circle cx="25" cy="80" r="6" fill="#FFD700" stroke="black" stroke-width="1"/>
          <circle cx="80" cy="50" r="6" fill="#FFD700" stroke="black" stroke-width="1"/>
          <circle cx="135" cy="80" r="6" fill="#FFD700" stroke="black" stroke-width="1"/>

          <!-- A simple "Smile" curve below the hat -->
          <path d="M 55 155 Q 80 175 105 155" fill="none" stroke="black" stroke-width="2" stroke-linecap="round"/>

          <!-- The Text "JOLLY" -->
          <text x="{WIDTH/2}" y="210" font-family="Times New Roman, serif" font-size="26" font-weight="bold" 
                fill="{main_color}" text-anchor="middle" letter-spacing="1">JOLLY</text>
                
          <!-- Decorative Star (Neutral Symbol) -->
          <polygon points="{star_points}" fill="{main_color}" transform="translate(0, -5)"/>
      </g>
    </svg>
    """
    
    with open(filename, "w") as f:
        f.write(svg_content)
    print(f"Generated {filename}")

# Generate Red Joker (1J)
create_better_joker("1J.svg", "#d40000")

# Generate Black Joker (2J)
create_better_joker("2J.svg", "#000000")

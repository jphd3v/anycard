import os

# Configuration to match the downloaded Brescia files (e.g. 2C.svg)
WIDTH = 159
HEIGHT = 319
CORNER_RADIUS = 12  # Matches the rounded look of the standard files
MARGIN = 10         # Distance between edge and the pattern
PAPER_COLOR = "#f2f2f2" # Light greyish tone seen in your screenshot
STROKE_COLOR = "#000000"

def generate_back(filename, color_primary, color_secondary):
    svg_content = f"""<svg width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <!-- Geometric Pattern (Tarocchi Style) -->
        <pattern id="BackPattern" x="0" y="0" width="16" height="16" patternUnits="userSpaceOnUse">
          <rect width="16" height="16" fill="{color_primary}"/>
          <!-- Simple Geometric Cross/Lattice -->
          <path d="M8 0 L16 8 L8 16 L0 8 Z" fill="none" stroke="{color_secondary}" stroke-width="1.5" opacity="0.9"/>
          <circle cx="8" cy="8" r="1.5" fill="{color_secondary}"/>
          <path d="M0 0 L16 16 M16 0 L0 16" stroke="{color_secondary}" stroke-width="0.5" opacity="0.4"/>
        </pattern>
      </defs>

      <!-- 1. Card Base (Paper) -->
      <!-- Adjusted to 159x319 to match the 2C.svg aspect ratio -->
      <rect x="0.5" y="0.5" width="{WIDTH-1}" height="{HEIGHT-1}" rx="{CORNER_RADIUS}" ry="{CORNER_RADIUS}" 
            fill="{PAPER_COLOR}" stroke="{STROKE_COLOR}" stroke-width="1" />

      <!-- 2. Inner Frame (Pattern Area) -->
      <!-- Defines the white/grey margin between the edge and the pattern -->
      <rect x="{MARGIN}" y="{MARGIN}" width="{WIDTH - (MARGIN*2)}" height="{HEIGHT - (MARGIN*2)}" rx="{CORNER_RADIUS/2}" ry="{CORNER_RADIUS/2}" 
            fill="url(#BackPattern)" stroke="{STROKE_COLOR}" stroke-width="1" />
    </svg>
    """
    
    with open(filename, "w") as f:
        f.write(svg_content)
    print(f"Generated {filename}")

# Generate Blue Back (1B)
generate_back("1B.svg", "#003366", "#ffffff") # Deep Blue & White

# Generate Red Back (2B) - Optional but useful for decks
generate_back("2B.svg", "#8b0000", "#ffffff") # Dark Red & White

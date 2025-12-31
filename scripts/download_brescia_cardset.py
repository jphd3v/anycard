import os
import urllib.request
import re
import time
from html.parser import HTMLParser

# --- Configuration ---
CATEGORY_URL = "https://commons.wikimedia.org/wiki/Category:Brescia_deck"
OUTPUT_DIR = "brescia"

# --- Mappings ---
SUIT_MAP = {
    'Swords': 'S',
    'Spade': 'S',
    'Cups': 'H',
    'Coppe': 'H',
    'Coins': 'D',
    'Denari': 'D',
    'Clubs': 'C',
    'Bastoni': 'C',
    'Batons': 'C'
}

# Column Index (0-12) -> Rank Code
COLUMN_RANK_MAP = [
    'A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'
]

def safe_urlopen(url_or_req):
    url = url_or_req.get_full_url() if isinstance(url_or_req, urllib.request.Request) else url_or_req
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ('http', 'https'):
        raise ValueError(f"Insecure URL scheme: {parsed.scheme}")
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    return urllib.request.urlopen(url_or_req)

def get_html(url):
    req = urllib.request.Request(
        url, 
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    )
    with safe_urlopen(req) as response:
        return response.read().decode('utf-8')

def download_file(file_page_url, output_name):
    print(f"Fetching info for {output_name}...")
    try:
        full_url = f"https://commons.wikimedia.org{file_page_url}"
        html = get_html(full_url)
        
        match = re.search(r'href="(https://upload\.wikimedia\.org/wikipedia/commons/[^"]+\.svg)"', html)
        
        if match:
            image_url = match.group(1)
            output_path = os.path.join(OUTPUT_DIR, output_name)
            
            req = urllib.request.Request(image_url, headers={'User-Agent': 'Mozilla/5.0'})
            with safe_urlopen(req) as response:
                with open(output_path, 'wb') as f:
                    f.write(response.read())
            print(f" -> Saved {output_name}")
            return True
        else:
            print(f" -> Could not find download link for {output_name}")
            return False
    except Exception as e:
        print(f" -> Error: {e}")
        return False

class DeckTableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_table = False
        self.in_row = False
        self.in_cell = False
        self.current_suit = None
        self.col_index = -1
        self.cards_found = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        
        if tag == 'table':
            if 'wikitable' in attrs.get('class', ''):
                self.in_table = True
        
        if self.in_table and tag == 'tr':
            self.in_row = True
            self.col_index = -1 
            self.current_suit = None 
            
        if self.in_row and (tag == 'td' or tag == 'th'):
            self.in_cell = True
            if tag == 'td':
                self.col_index += 1

        if self.in_cell and tag == 'a':
            href = attrs.get('href')
            if href and 'File:' in href and href.endswith('.svg'):
                if self.current_suit and 0 <= self.col_index < len(COLUMN_RANK_MAP):
                    rank = COLUMN_RANK_MAP[self.col_index]
                    filename = f"{rank}{self.current_suit}.svg"
                    self.cards_found[filename] = href

    def handle_endtag(self, tag):
        if tag == 'table': self.in_table = False
        if tag == 'tr': self.in_row = False
        if tag == 'td' or tag == 'th': self.in_cell = False

    def handle_data(self, data):
        if self.in_cell:
            text = data.strip()
            if not text: return
            
            # Case-insensitive check
            for key, code in SUIT_MAP.items():
                if key.lower() in text.lower():
                    self.current_suit = code

def find_extras(html):
    extras = {}
    back_match = re.search(r'href="(/wiki/File:[^"]*?(?:Dorso|Back)[^"]*?\.svg)"', html, re.IGNORECASE)
    if back_match:
        extras['1B.svg'] = back_match.group(1)
        
    jokers = set(re.findall(r'href="(/wiki/File:[^"]*?(?:Jolly|Joker)[^"]*?\.svg)"', html, re.IGNORECASE))
    jokers = sorted(list(jokers))
    if len(jokers) > 0: extras['1J.svg'] = jokers[0]
    if len(jokers) > 1: extras['2J.svg'] = jokers[1]
    return extras

def main():
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)

    print(f"Scanning {CATEGORY_URL}...")
    html_content = get_html(CATEGORY_URL)

    parser = DeckTableParser()
    parser.feed(html_content)
    cards = parser.cards_found
    
    print(f"Found {len(cards)} cards in the table.")
    
    extras = find_extras(html_content)
    all_cards = {**cards, **extras}

    for filename, page_url in all_cards.items():
        download_file(page_url, filename)
        time.sleep(0.5)

    print(f"\nDone! Check '{OUTPUT_DIR}'.")

if __name__ == "__main__":
    main()
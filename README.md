# AnyCard

AnyCard is a card game engine designed for implementing and playing almost any card game.

## Quick Start

To get the project up and running locally, follow these steps:

1.  **Install dependencies** for the root, backend, and frontend:
    ```bash
    npm install
    npm install --prefix backend
    npm install --prefix frontend
    ```
2.  **Configure environment variables:** (Note: The default settings are a good starting point but make sure to adjust e.g. CORS settings, LLM configuration, and whatnot to conform to your setup.)

    ```bash
    cp backend/.env.example backend/.env
    cp frontend/.env.example frontend/.env
    ```

3.  **Start the development server:**
    ```bash
    npm run dev
    ```
4.  **Play the game:**
    Open your browser and navigate to `http://localhost:5173`.

## Verification

To ensure that your changes are correct and do not break existing functionality, run the verification script from the root. This is especially important for Agent-led development, as it provides a deterministic "safety net" for non-deterministic AI outputs:

```bash
npm run verify
```

This script performs the following checks:

- **Linting:** Runs ESLint on both frontend and backend.
- **Type Checking & Build:** Runs TypeScript compiler and Vite build.
- **Integration Tests:** Runs all automated integration tests.
- **Security Scan:** Runs Semgrep (if installed) to check for common security issues and best practices.

Agents working on this repository are required to run this script and ensure it passes before completing any task.

## Technology

- **Frontend:** React, Vite, TypeScript
- **Backend:** Node.js, TypeScript

## Development & Disclaimer

This project was developed almost entirely through "vibe coding" techniques, utilizing various coding agents and LLMs—primarily GPT Codex, but also tools like Qwen CLI and Gemini CLI. While very little manual code was written (though some manual fixes were applied), the project is driven by a clear intuition and vision of what I wanted to create.

**Important:** This project is **not production-ready**. Due to its experimental development nature, the codebase may contain security vulnerabilities. Specifically, authentication has **not** been implemented.

This is for **demo purposes only**. Please consult the `LICENSE.txt` file, which explicitly states that the software is provided without warranty of any kind.

## Background & Philosophy

As software developers, we often assume card games are simple or even naive examples of what software can do, but they actually offer a surprising depth of features—and they happen to serve as an excellent playground for **vibe coding**.

### Scope & Mission

AnyCard was designed to implement and play almost any card game, focusing on multiplayer classics such as Canasta, Bridge, and Gin Rummy. While the engine can support popular games like Poker and Blackjack, a primary motivation was to provide implementations for less common games—like **Skruuvi**—rather than contributing to the oversaturation of existing clones.

The engine is strictly focused on **turn-based games**. It excludes real-time games (like Spit or Speed) and those requiring copyrighted or custom decks (like Uno). While the current focus is on multiplayer mechanics, it is likely capable of supporting solitaire games with minor adjustments.

### Aesthetics & Look-and-Feel

I have placed a strong emphasis on graphics and the overall "look and feel." Throughout development, I have tried to keep the aesthetics and gameplay as close as possible to the natural experience of playing with a physical deck.

- **High-Quality SVGs:** While many card game implementations exist, they often lack high-quality visuals. AnyCard uses high-quality SVG card sets sourced from the community, which work beautifully even on high-resolution mobile devices.
- **Mobile-First & Multi-Device:** Mobile support has been a first-class priority from day one. The layout is designed to be playable on small screens, but nothing prevents using a smart TV as a spectator overview while players use tablets or phones for their hands. Naturally, involved games like Bridge and Canasta benefit from bigger screens, but I have done my best to make them fully playable on mobile.

### Rule Fidelity & Reputable Sources

I have aimed to implement the games as faithfully as possible to their classical, most well-known rules, without "watering down" mechanics due to the constraints of a digital format.

- **Authoritative Sources:** My go-to reference has been [Pagat.com](https://www.pagat.com) (edited by John McLeod). I include links to the specific rules for each game implementation and am grateful to the authors who publish these rules freely.
- **Simplification & Constraints:** Some compromises were necessary for this prototype. Many games support a variable number of players, but since rules often change significantly based on player count (e.g., 2-player vs. 4-player Bridge), I have often fixed the number of players for specific implementations to keep the logic manageable. Adding configurable player counts and rule variations is a goal for the future.

### AI Opponents & LLM Integration

Since finding enough human players for games that require 3 or 4 people can be a challenge, I have experimented with a simple idea to add AI.

The engine passes the publicly visible game state, the rules, and basic strategy advice to a **Large Language Model (LLM)**, which then decides on a move. This approach works to an extent, but it has technical trade-offs:

- **Performance:** Local models (like Mistral/Devstral) might take 20-30 seconds per move in complex games, whereas cloud-based models are faster but come with costs. While some smaller local models can be very fast, I have yet to confirm if they can play at a high level. Certain mechanics—especially the "free" melding in **Rummy-based** games—still tend to confuse the AI. Additionally, the **Bidding** or **Auction phase** (for example, in **Bridge**) has proven particularly difficult for current LLMs to master (this is perhaps to no surprise as it can be considered complex in real life, as well).
- **Client-Side AI:** To avoid prohibitively expensive server costs (and storing end-user's API keys on the server), I have implemented an option for the **browser (client) to handle LLM requests directly**. This allows users to use their own API credits (keys are stored only in session storage) and ensures privacy. This approach requires addressing CORS and mixed-content issues for certain providers or local LLM runners like LM Studio. I don't see it a big issue to connect e.g. to a LM Studio on your local network if you want to experiment with it, but as adviced earlier on, this software comes without a warranty of any kind, refer to the license for more details.

### AI Model Evaluation

Testing was conducted with various local models on Apple Silicon (M4 Max 48GB) using LM Studio. Key findings:

| Model                             | Speed               | Strategy Quality | Notes                                                                         |
| --------------------------------- | ------------------- | ---------------- | ----------------------------------------------------------------------------- |
| nvidia/nemotron-3-nano            | Very fast (~2s)     | Poor             | Always picks same option (c1 bias), no reasoning; timeouts with thinking on   |
| qwen/qwen3-4b-2507                | Fast (~5s)          | Poor             | Incorrect deadwood strategy, occasional ID mapping errors                     |
| qwen/qwen3-vl-8b                  | Variable (4-12s)    | Poor             | Wrong strategy, timeouts occur                                                |
| mistralai/devstral-small          | Variable (8-25s)    | Mixed            | Shows reasoning but inconsistent strategy; sometimes correct, sometimes wrong |
| qwen/qwen3-14b (thinking on)      | Very slow (30-90s+) | Good             | Correct strategy but frequent timeouts                                        |
| **qwen/qwen3-14b (thinking off)** | Fast (~3s)          | Good             | Best balance of speed and quality                                             |

**Recommended configuration for local play:**

- **Model:** qwen/qwen3-14b (or similar 14B+ model)
- **Temperature:** 0.15
- **Thinking mode:** Disabled (in LM Studio settings)

**Key observations:**

- Smaller models (4B) struggle with game strategy—they may discard low-value cards when they should discard high-value cards not in melds
- Qwen3's "thinking mode" produces better reasoning but is too slow for real-time play
- 14B models with thinking disabled offer the best tradeoff: fast responses with correct strategic decisions
- Temperature 0.15 helps with consistent ID mapping (choosing the candidate that matches the stated reasoning)

**Game-specific strategy issues (even with qwen3-14b):**

- **Gin Rummy**: Generally good—correctly identifies melds, discards high-value deadwood
- **Canasta**: Weak strategic awareness—may discard wild cards (Jokers/2s) which is almost never correct, and discards cards that opponents have already melded (e.g., Aces when opponent team has an Ace meld), making it easy for them to pick up the pile

### Project Status

The project is currently at a **demo level**. While I aim for completeness and fidelity, I am not an expert in every variant of every game and I simply haven't had time to run them all through. In that sense they could be considered work in progress and consequently, there may be bugs or missing features.

## License & Copyright

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. See the `LICENSE.txt` file for the full text.

Copyright (C) 2025 JPH.

### Third-Party Licenses

AnyCard includes several third-party assets with their own licenses. We are grateful to the authors for making these available:

- **Playing Card Sets** (located in `frontend/public/cards/`):
  - **Atlasnye**: CC0 1.0 Universal by Dmitry Fomin.
  - **Brescia**: CC BY-SA 4.0 by ZZandro.
  - **Digital Design Labs**: LGPL 3.0 by Mike Hall & Chris Aguilar.
  - **SVG-cards**: LGPL-2.1 by htdebeer.
  - **Vector Playing Cards**: Public Domain / WTFPL by Byron Knoll and notpeter.
  - **Adrian Kennard**: CC0 1.0 Universal.
  - **David Bellot**: GNU LGPL v3.0 (Card back and Jokers used in several sets).

- **Game Rules**:
  - Many implementations are based on the rules documented at [Pagat.com](https://www.pagat.com), edited by John McLeod.

- **Software Dependencies**:
  - Standard libraries (React, Node.js, Express, Socket.io, LangChain, etc.) are used under their respective permissive licenses (MIT, Apache-2.0, etc.).

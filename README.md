# agentUI

A node-based flow graph UI to visualize AI agent execution, replacing traditional chat interfaces with an interactive visual representation of tool calls, subagents, and message flows.

<!-- Add a screenshot here: ![Agent Flow UI](./docs/screenshot.png) -->

## Features

- **Radial Flow Layout**: Messages and tool calls arranged in a radial pattern around a central node
- **Tool Batching**: Consecutive tool calls merged into single "Tools (n)" nodes for cleaner visualization
- **Subagent Visualization**: Independent subagent "universes" with their own radial layouts
- **Real-time Updates**: WebSocket-based telemetry for live graph updates
- **Breathing Animation**: Running subagent nodes display animated glow effect
- **Persistent Layout**: Node positions saved and restored across sessions
- **Light/Dark Theme**: Toggle between themes
- **Interactive Inspector**: Click nodes to view details, arguments, and results

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend (React)                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  React Flow │  │   Chat UI   │  │  Inspector Panel    │  │
│  │  (Graph)    │  │             │  │                     │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │             │
│         └────────────────┴─────────────────────┘             │
│                          │                                   │
│                    WebSocket + REST                          │
└──────────────────────────┼───────────────────────────────────┘
                           │
┌──────────────────────────┼───────────────────────────────────┐
│                     Backend (Python)                         │
│  ┌─────────────┐  ┌──────┴──────┐  ┌─────────────────────┐  │
│  │   Agent     │  │  UI Server  │  │  Telemetry Emitter  │  │
│  │   Loop      │──│  (aiohttp)  │──│                     │  │
│  └──────┬──────┘  └─────────────┘  └─────────────────────┘  │
│         │                                                    │
│  ┌──────┴──────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Tools     │  │  Subagent   │  │  Session Manager    │  │
│  │   Manager   │  │  Manager    │  │                     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+
- An OpenAI-compatible API key

### Installation

1. Clone the repository:
```bash
git clone https://github.com/nerslm/agentUI.git
cd agentUI
```

2. Install Python dependencies:
```bash
pip install -e .
```

3. Install frontend dependencies and build:
```bash
cd ui
npm install
npm run build
cd ..
```

4. Set your API key:
```bash
export OPENAI_API_KEY="your-api-key"
# Or for other providers:
export ANTHROPIC_API_KEY="your-api-key"
```

> **Note**: It's recommended to use a virtual environment (`python -m venv .venv && source .venv/bin/activate`) before installing dependencies.

### Running

Start both the gateway (agent backend) and UI server:

```bash
# Terminal 1: Start the gateway
nanobot gateway --port 18790

# Terminal 2: Start the UI server
nanobot ui --port 18791
```

Open http://localhost:18791 in your browser.

## Configuration

Create a `config.yaml` file in the workspace directory:

```yaml
provider: openai  # or anthropic, openrouter
model: gpt-4o
max_tokens: 4096

# Optional: Enable specific tools
tools:
  - read_file
  - write_file
  - list_dir
  - shell
  - spawn  # Enable subagent spawning
```

## UI Controls

| Button | Description |
|--------|-------------|
| **Light/Dark** | Toggle theme |
| **Hide/Show panel** | Toggle inspector panel |
| **Relayout** | Recalculate node positions |
| **Save** | Manually save current layout |
| **Session dropdown** | Switch between chat sessions |
| **+ New** | Create a new session |

## Node Types

| Color | Type | Description |
|-------|------|-------------|
| 🔵 Blue | Message | User or assistant messages |
| 🟢 Green | Tool | Tool call batches |
| 🟣 Purple | Subagent | Background subagent tasks |
| 🔴 Red | Error | Failed operations |

## Development

### Frontend Development

```bash
cd ui
npm install
npm run dev  # Start Vite dev server with hot reload
```

### Backend Development

```bash
pip install -e ".[dev]"
pytest  # Run tests
```

## Project Structure

```
.
├── nanobot/
│   ├── agent/           # Agent loop, tools, subagent manager
│   ├── bus/             # Message bus for async communication
│   ├── context/         # Prompt building and context management
│   ├── providers/       # LLM provider integrations
│   ├── session/         # Session and history management
│   ├── telemetry/       # Event emission for UI visualization
│   └── ui/              # UI server (aiohttp)
├── ui/
│   ├── src/
│   │   ├── App.jsx      # Main React component
│   │   └── styles.css   # Styling
│   └── package.json
├── pyproject.toml
└── README.md
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- Built with [React Flow](https://reactflow.dev/) for graph visualization
- Inspired by the need to understand AI agent behavior beyond chat logs

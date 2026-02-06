import React, { useMemo, useRef, useState, useEffect } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';

const STATUS_COLORS = {
  idle: '#8b8b8b',
  running: '#f39c6b',
  ok: '#57b894',
  error: '#e35d6a',
  received: '#5aa9e6',
};

const NODE_COLORS = {
  message: '#5aa9e6',
  llm: '#f39c6b',
  tool: '#57b894',
  subagent: '#9b8cf0',
  error: '#e35d6a',
};

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function msDiff(start, end) {
  if (!start || !end) return '';
  const diff = new Date(end).getTime() - new Date(start).getTime();
  if (Number.isNaN(diff)) return '';
  return `${diff} ms`;
}

function buildNodeLabel(info) {
  const title = info.title || info.nodeType;
  const status = info.status ? `· ${info.status}` : '';
  return `${title} ${status}`.trim();
}

function titleForEvent(event) {
  const { nodeType } = event.node || {};
  if (nodeType === 'message') return 'Message';
  if (nodeType === 'llm') return 'LLM Request';
  if (nodeType === 'tool') return event.data?.tool_name ? `Tool: ${event.data.tool_name}` : 'Tool';
  if (nodeType === 'subagent') return event.data?.label ? `Subagent: ${event.data.label}` : 'Subagent';
  return event.type;
}

function SmartNode({ data }) {
  const isRunningSubagent = data?.nodeType === 'subagent' && data?.status !== 'ok' && data?.status !== 'error';
  const [breathPhase, setBreathPhase] = React.useState(0);

  React.useEffect(() => {
    if (!isRunningSubagent) return;
    const timer = setInterval(() => {
      setBreathPhase((p) => (p + 1) % 20); // 20 phases for smooth breathing
    }, 100); // Update every 100ms
    return () => clearInterval(timer);
  }, [isRunningSubagent]);

  // Calculate breathing glow intensity (0 to 1 to 0)
  const glowIntensity = isRunningSubagent ? Math.sin((breathPhase / 20) * Math.PI * 2) * 0.5 + 0.5 : 0;
  const glowStyle = isRunningSubagent ? {
    position: 'absolute',
    top: '-4px',
    left: '-4px',
    right: '-4px',
    bottom: '-4px',
    borderRadius: '50%',
    border: `3px solid rgba(120, 80, 255, ${0.3 + glowIntensity * 0.7})`,
    boxShadow: `0 0 ${10 + glowIntensity * 25}px rgba(120, 80, 255, ${0.2 + glowIntensity * 0.6})`,
    pointerEvents: 'none',
  } : {};

  return (
    <div className="smart-node" style={{ position: 'relative' }}>
      {isRunningSubagent && <div style={glowStyle} />}
      {/* Center handles for omnidirectional connections */}
      <Handle
        type="source"
        id="source-center"
        position={Position.Right}
        style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)', opacity: 0 }}
      />
      <Handle
        type="target"
        id="target-center"
        position={Position.Left}
        style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)', opacity: 0 }}
      />

      <div style={{ fontWeight: 600 }}>{data?.label}</div>
    </div>
  );
}

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState([
    {
      id: 'main',
      type: 'smart',
      position: { x: 400, y: 300 },
      draggable: true,
      selectable: true,
      data: {
        label: 'Chat (You ↔ Agent)',
        status: 'idle',
        nodeType: 'message',
        onSelect: () => setSelectedId('main'),
      },
      style: {
        background: 'var(--node-main-bg)',
        color: 'var(--node-text)',
        border: '3px solid #5aa9e6',
        width: '100px',
        height: '100px',
        borderRadius: '50%',
        boxShadow: 'var(--node-main-shadow)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        fontSize: '12px',
      },
    },
  ]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState('main');

  // UI session management (each UI session has its own chat + graph).
  const [sessionKey, setSessionKey] = useState(() => {
    try {
      return localStorage.getItem('lastSessionKey') || 'ui:main';
    } catch {
      return 'ui:main';
    }
  });
  const sessionKeyRef = useRef(sessionKey); // Ref for use in event handlers (avoid stale closure)
  const [availableSessions, setAvailableSessions] = useState([]);
  const layoutRef = useRef({});
  const replayingRef = useRef(false);

  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatQueue, setChatQueue] = useState([]); // pending messages when busy
  const [chatStream, setChatStream] = useState(null); // "" while thinking, null when idle
  const [chatStreamStartedAt, setChatStreamStartedAt] = useState(null);
  const pendingClientIdsRef = useRef({}); // clientMessageId -> optimistic message id
  const fileInputRef = useRef(null);

  const generateUUID = () => {
    // Browser-safe UUID fallback.
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };

  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('theme') || 'dark';
    } catch {
      return 'dark';
    }
  });

  const [inspectorOpen, setInspectorOpen] = useState(() => {
    try {
      const raw = localStorage.getItem('inspectorOpen');
      return raw == null ? true : raw === 'true';
    } catch {
      return true;
    }
  });
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    try {
      const raw = localStorage.getItem('inspectorWidth');
      const n = raw ? Number(raw) : 360;
      return Number.isFinite(n) ? n : 360;
    } catch {
      return 360;
    }
  });
  const resizingRef = useRef(false);
  const eventsRef = useRef({});
  const nodeInfoRef = useRef({});
  const positionRef = useRef({});
  const depthRef = useRef({});
  const laneCountRef = useRef({});
  const skippedParentMap = useRef({}); // Maps skipped nodeId -> its parentId
  const toolBatchData = useRef({}); // Maps batchNodeId -> { tools: [...], runningCount, ... }
  // Per-session chain state: { [sessionKey]: { lastChainNode, currentToolBatch, subagentNodeId? } }
  const sessionChains = useRef({});
  const mainSessionKey = useRef(null); // Track the main session key
  const subagentToSession = useRef({}); // Maps subagent nodeId -> its sessionKey

  // Radial layout state
  const conversationChains = useRef([]); // [{id, startNodeId, nodes: [{nodeId, depth}], angle}]
  const nodeToChain = useRef({}); // nodeId -> chainId
  const nodeDepthInChain = useRef({}); // nodeId -> depth within chain
  
  // Subagent centers - each subagent is its own "universe"
  const subagentCenters = useRef({}); // subagentNodeId -> {x, y, chains: [], nodeToChain: {}, nodeDepth: {}}
  const nodeToSubagent = useRef({}); // nodeId -> subagentNodeId (for nodes inside subagent)
  
  // Layout constants
  const CENTER_X = 500;
  const CENTER_Y = 400;
  const BASE_RADIUS = 200;
  const RADIUS_STEP = 150;
  const SUBAGENT_DISTANCE = 1000; // Distance from main center to subagent center
  const SUBAGENT_RADIUS = 120; // Base radius for subagent's own layout
  const SUBAGENT_STEP = 100; // Radius step for subagent's nodes

  // Recalculate angles for all chains and update node positions
  const relayoutAllNodes = () => {
    const chains = conversationChains.current;
    const n = chains.length;
    if (n === 0) return;

    // Recalculate angles for main chains
    chains.forEach((chain, i) => {
      chain.angle = (i / n) * 2 * Math.PI; // radians
    });

    // Update all node positions
    setNodes(current => current.map(node => {
      if (node.id === 'main') {
        return { ...node, position: { x: CENTER_X, y: CENTER_Y } };
      }

      // Check if node belongs to a subagent
      const subagentId = nodeToSubagent.current[node.id];
      if (subagentId) {
        const subagent = subagentCenters.current[subagentId];
        if (subagent) {
          const chainId = subagent.nodeToChain[node.id];
          const chain = subagent.chains.find(c => c.id === chainId);
          if (chain) {
            const depth = subagent.nodeDepth[node.id] || 1;
            const radius = SUBAGENT_RADIUS + (depth - 1) * SUBAGENT_STEP;
            const x = subagent.x + radius * Math.cos(chain.angle);
            const y = subagent.y + radius * Math.sin(chain.angle);
            positionRef.current[node.id] = { x, y };
            return { ...node, position: { x, y } };
          }
        }
      }

      // Check if this is a subagent center node
      if (subagentCenters.current[node.id]) {
        const subagent = subagentCenters.current[node.id];
        return { ...node, position: { x: subagent.x, y: subagent.y } };
      }

      // Main chain node
      const chainId = nodeToChain.current[node.id];
      const chain = chains.find(c => c.id === chainId);
      if (!chain) return node;

      const depth = nodeDepthInChain.current[node.id] || 1;
      const radius = BASE_RADIUS + (depth - 1) * RADIUS_STEP;
      const x = CENTER_X + radius * Math.cos(chain.angle);
      const y = CENTER_Y + radius * Math.sin(chain.angle);

      positionRef.current[node.id] = { x, y };
      return { ...node, position: { x, y } };
    }));
  };

  // Relayout nodes within a subagent
  const relayoutSubagentNodes = (subagentId) => {
    const subagent = subagentCenters.current[subagentId];
    if (!subagent) return;

    const chains = subagent.chains;
    const n = chains.length;
    if (n === 0) return;

    // Recalculate angles
    chains.forEach((chain, i) => {
      chain.angle = (i / n) * 2 * Math.PI;
    });

    // Update positions
    setNodes(current => current.map(node => {
      if (nodeToSubagent.current[node.id] !== subagentId) return node;
      
      const chainId = subagent.nodeToChain[node.id];
      const chain = chains.find(c => c.id === chainId);
      if (!chain) return node;

      const depth = subagent.nodeDepth[node.id] || 1;
      const radius = SUBAGENT_RADIUS + (depth - 1) * SUBAGENT_STEP;
      const x = subagent.x + radius * Math.cos(chain.angle);
      const y = subagent.y + radius * Math.sin(chain.angle);

      positionRef.current[node.id] = { x, y };
      return { ...node, position: { x, y } };
    }));
  };

  // Add a node to radial layout
  const addNodeToRadialLayout = (nodeId, nodeType, parentId, isUserMessage, isSubagent = false, subagentId = null) => {
    // If we have a saved position for this node, use it (for replay/refresh)
    const savedPos = layoutRef.current?.[nodeId];
    if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
      // Still need to update tracking data structures if they're missing
      if (isSubagent && !subagentCenters.current[nodeId]) {
        subagentCenters.current[nodeId] = {
          x: savedPos.x,
          y: savedPos.y,
          chains: [],
          nodeToChain: {},
          nodeDepth: {},
          parentAngle: 0,
        };
      }
      return savedPos;
    }
    
    // Handle subagent center node creation
    if (isSubagent) {
      // Find the parent chain's angle to place subagent in that direction
      const parentChainId = nodeToChain.current[parentId];
      const parentChain = conversationChains.current.find(c => c.id === parentChainId);
      const angle = parentChain ? parentChain.angle : 0;
      
      // Place subagent center at far end of that direction
      const x = CENTER_X + SUBAGENT_DISTANCE * Math.cos(angle);
      const y = CENTER_Y + SUBAGENT_DISTANCE * Math.sin(angle);
      
      // Initialize subagent's own layout system
      subagentCenters.current[nodeId] = {
        x,
        y,
        chains: [],
        nodeToChain: {},
        nodeDepth: {},
        parentAngle: angle,
      };
      
      return { x, y };
    }

    // Check if this node belongs to a subagent
    if (subagentId || nodeToSubagent.current[parentId]) {
      const actualSubagentId = subagentId || nodeToSubagent.current[parentId];
      const subagent = subagentCenters.current[actualSubagentId];
      
      if (!subagent) {
        // Fallback
        return { x: CENTER_X + 300, y: CENTER_Y };
      }

      nodeToSubagent.current[nodeId] = actualSubagentId;

      // In subagent: every message node starts a new chain (it's the agent's "thinking")
      const startsNewSubagentChain = nodeType === 'message' || subagent.chains.length === 0;
      
      if (startsNewSubagentChain) {
        // New chain in subagent - each "thought" spawns a new direction
        const chainId = `subchain-${nodeId}`;
        const newChain = {
          id: chainId,
          nodes: [{ nodeId, depth: 1 }],
          angle: 0,
        };
        subagent.chains.push(newChain);
        subagent.nodeToChain[nodeId] = chainId;
        subagent.nodeDepth[nodeId] = 1;
        
        relayoutSubagentNodes(actualSubagentId);
        
        const chain = subagent.chains[subagent.chains.length - 1];
        const x = subagent.x + SUBAGENT_RADIUS * Math.cos(chain.angle);
        const y = subagent.y + SUBAGENT_RADIUS * Math.sin(chain.angle);
        return { x, y };
      } else {
        // Add to existing chain
        const parentChainId = subagent.nodeToChain[parentId];
        const chain = subagent.chains.find(c => c.id === parentChainId) || subagent.chains[subagent.chains.length - 1];
        
        const parentDepth = subagent.nodeDepth[parentId] || 0;
        const depth = parentDepth + 1;
        chain.nodes.push({ nodeId, depth });
        subagent.nodeToChain[nodeId] = chain.id;
        subagent.nodeDepth[nodeId] = depth;
        
        const radius = SUBAGENT_RADIUS + (depth - 1) * SUBAGENT_STEP;
        const x = subagent.x + radius * Math.cos(chain.angle);
        const y = subagent.y + radius * Math.sin(chain.angle);
        return { x, y };
      }
    }

    // Main layout
    if (isUserMessage) {
      // Create new chain for user message
      const chainId = `chain-${nodeId}`;
      const newChain = {
        id: chainId,
        startNodeId: nodeId,
        nodes: [{ nodeId, depth: 1 }],
        angle: 0,
      };
      conversationChains.current.push(newChain);
      nodeToChain.current[nodeId] = chainId;
      nodeDepthInChain.current[nodeId] = 1;
      
      relayoutAllNodes();
      
      const chain = conversationChains.current[conversationChains.current.length - 1];
      const x = CENTER_X + BASE_RADIUS * Math.cos(chain.angle);
      const y = CENTER_Y + BASE_RADIUS * Math.sin(chain.angle);
      return { x, y };
    } else {
      // Find parent's chain and add to it
      const parentChainId = nodeToChain.current[parentId];
      if (!parentChainId) {
        const chains = conversationChains.current;
        if (chains.length > 0) {
          const lastChain = chains[chains.length - 1];
          const parentDepth = nodeDepthInChain.current[parentId] || 0;
          const depth = parentDepth + 1;
          lastChain.nodes.push({ nodeId, depth });
          nodeToChain.current[nodeId] = lastChain.id;
          nodeDepthInChain.current[nodeId] = depth;
          
          const radius = BASE_RADIUS + (depth - 1) * RADIUS_STEP;
          const x = CENTER_X + radius * Math.cos(lastChain.angle);
          const y = CENTER_Y + radius * Math.sin(lastChain.angle);
          return { x, y };
        }
        return { x: CENTER_X + 200, y: CENTER_Y };
      }

      const chain = conversationChains.current.find(c => c.id === parentChainId);
      if (!chain) return { x: CENTER_X + 200, y: CENTER_Y };

      const parentDepth = nodeDepthInChain.current[parentId] || 0;
      const depth = parentDepth + 1;
      chain.nodes.push({ nodeId, depth });
      nodeToChain.current[nodeId] = chain.id;
      nodeDepthInChain.current[nodeId] = depth;

      const radius = BASE_RADIUS + (depth - 1) * RADIUS_STEP;
      const x = CENTER_X + radius * Math.cos(chain.angle);
      const y = CENTER_Y + radius * Math.sin(chain.angle);
      return { x, y };
    }
  };


  const selectedNode = useMemo(() => {
    if (!selectedId) return null;
    if (selectedId === 'main') {
      return {
        nodeId: 'main',
        nodeType: 'chat',
        status: chatBusy ? 'running' : 'idle',
        title: 'Chat (UI)',
        data: {},
        startedAt: null,
        finishedAt: null,
      };
    }
    return nodeInfoRef.current[selectedId] || null;
  }, [selectedId, nodes, chatBusy]);

  // Build a read-only transcript when selecting a subagent node.
  const subagentTranscript = useMemo(() => {
    const node = selectedNode;
    if (!node || node.nodeType !== 'subagent') return [];

    const items = [];
    try {
      const all = eventsRef.current;
      for (const nodeId of Object.keys(all)) {
        const evs = all[nodeId] || [];
        for (const ev of evs) {
          if (ev?.type !== 'subagent.message.created') continue;
          if (ev?.node?.parentId !== selectedId) continue;
          const role = ev?.data?.role;
          const content = ev?.data?.content;
          if (role !== 'user' && role !== 'assistant') continue;
          if (!content) continue;
          items.push({
            role,
            content,
            ts: ev.ts,
            id: ev.eventId,
          });
        }
      }
    } catch {
      return [];
    }

    items.sort((a, b) => {
      const ta = new Date(a.ts || 0).getTime();
      const tb = new Date(b.ts || 0).getTime();
      return ta - tb;
    });

    return items;
  }, [selectedNode, selectedId]);

  const resetGraphState = () => {
    // Reset graph-related state for session switching/replay.
    eventsRef.current = {};
    nodeInfoRef.current = {};
    positionRef.current = {};
    depthRef.current = {};
    laneCountRef.current = {};
    skippedParentMap.current = {};
    toolBatchData.current = {};
    sessionChains.current = {};
    mainSessionKey.current = null;
    subagentToSession.current = {};
    conversationChains.current = [];
    nodeToChain.current = {};
    nodeDepthInChain.current = {};
    subagentCenters.current = {};
    nodeToSubagent.current = {};

    setNodes([
      {
        id: 'main',
        type: 'smart',
        position: { x: 400, y: 300 },
        draggable: true,
        selectable: true,
        data: {
          label: 'Chat (You ↔ Agent)',
          status: 'idle',
          nodeType: 'message',
          onSelect: () => setSelectedId('main'),
        },
        style: {
          background: 'var(--node-main-bg)',
          color: 'var(--node-text)',
          border: '3px solid #5aa9e6',
          width: '100px',
          height: '100px',
          borderRadius: '50%',
          boxShadow: 'var(--node-main-shadow)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          fontSize: '12px',
        },
      },
    ]);
    setEdges([]);
    setSelectedId('main');
  };

  const loadSession = async (key, forceRelayout = false) => {
    // 1) Load layout (positions + radial data + saved nodes/edges)
    let savedLayout = null;
    try {
      const r = await fetch(`/api/layout?sessionKey=${encodeURIComponent(key)}`);
      const data = await r.json();
      savedLayout = data?.layout && typeof data.layout === 'object' ? data.layout : {};
      // Support both old format (direct positions) and new format (positions + radialData)
      if (savedLayout.positions) {
        layoutRef.current = savedLayout.positions;
      } else {
        layoutRef.current = savedLayout;
      }
    } catch {
      layoutRef.current = {};
    }

    // 2) Reset graph state
    resetGraphState();
    
    // 3) Restore radial layout data if available
    if (savedLayout?.radialData) {
      const rd = savedLayout.radialData;
      if (rd.conversationChains) conversationChains.current = rd.conversationChains;
      if (rd.nodeToChain) nodeToChain.current = rd.nodeToChain;
      if (rd.nodeDepthInChain) nodeDepthInChain.current = rd.nodeDepthInChain;
      if (rd.subagentCenters) subagentCenters.current = rd.subagentCenters;
      if (rd.nodeToSubagent) nodeToSubagent.current = rd.nodeToSubagent;
    }

    // 4) Load chat history
    try {
      const r = await fetch(`/api/history?sessionKey=${encodeURIComponent(key)}`);
      const data = await r.json();
      if (data?.ok && Array.isArray(data.messages)) {
        setChatMessages(
          data.messages.map((m, idx) => ({
            role: m.role,
            content: m.content,
            ts: m.ts || null,
            id: `hist-${idx}-${m.ts || ''}`,
          }))
        );
      } else {
        setChatMessages([]);
      }
    } catch {
      setChatMessages([]);
    }

    // 5) Restore saved nodes/edges directly, or replay telemetry if not available or forced
    const hasSavedGraph = savedLayout?.savedNodes?.length > 0 && !forceRelayout;
    
    if (hasSavedGraph) {
      // Directly restore saved nodes and edges (stable layout)
      setNodes(savedLayout.savedNodes.map(n => ({
        ...n,
        data: {
          ...n.data,
          onSelect: () => setSelectedId(n.id),
        },
      })));
      setEdges(savedLayout.savedEdges || []);
      // Restore nodeInfoRef for inspector
      for (const n of savedLayout.savedNodes) {
        if (n.data) {
          nodeInfoRef.current[n.id] = {
            nodeType: n.data.nodeType,
            title: n.data.label,
            status: n.data.status,
          };
        }
      }
    } else {
      // Replay telemetry to reconstruct graph (recalculates layout)
      try {
        replayingRef.current = true;
        const r = await fetch(`/api/telemetry_bundle?sessionKey=${encodeURIComponent(key)}`);
        const data = await r.json();
        if (data?.ok && Array.isArray(data.events)) {
          for (const ev of data.events) {
            handleEvent(ev);
          }
        }
      } catch {
        // ignore
      } finally {
        replayingRef.current = false;
      }
    }
  };

  const refreshSessionsList = async (preferKey) => {
    try {
      const r = await fetch('/api/sessions');
      const data = await r.json();
      if (data?.ok && Array.isArray(data.sessions)) {
        // Server already sorts by updated_at desc; keep as-is.
        setAvailableSessions(data.sessions);

        const keys = data.sessions.map((s) => s.key).filter(Boolean);
        const desired = preferKey || sessionKey;

        // If the desired key isn't present, fall back to the most recent session.
        if (desired && keys.includes(desired)) {
          if (preferKey) setSessionKey(preferKey);
        } else if (keys.length > 0) {
          setSessionKey(keys[0]);
          await loadSession(keys[0]);
        }
      }
    } catch {
      // ignore
    }
  };

  const createNewSession = async () => {
    const r = await fetch('/api/new_session', { method: 'POST' });
    const data = await r.json();
    if (!data?.ok || !data.sessionKey) return;
    await refreshSessionsList(data.sessionKey);
    await loadSession(data.sessionKey);
  };

  useEffect(() => {
    // Initial load: list sessions and load the last active (or most recent) session.
    refreshSessionsList(sessionKey);
    loadSession(sessionKey);

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}/ws/telemetry`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Telemetry connected');
    };

    ws.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (!event || !event.node || !event.node.nodeId) return;
        // Debug: log subagent events
        if (event.type?.includes('subagent')) {
          console.log('Subagent event:', event.type, event.node.nodeId, event);
        }
        handleEvent(event);
      } catch (err) {
        console.warn('Telemetry parse error', err);
      }
    };

    ws.onerror = (err) => {
      console.warn('Telemetry error', err);
    };

    return () => ws.close();
  }, []);

  const handleEvent = (event) => {
    const { nodeId, nodeType } = event.node;
    let { parentId } = event.node;
    const eventSessionKey = event.sessionKey || 'main';

    // Skip LLM nodes to keep the graph cleaner (avoid tool-LLM-tool-LLM chains).
    // But record the mapping so children can find the real parent.
    if (nodeType === 'llm') {
      skippedParentMap.current[nodeId] = parentId || 'main';
      return;
    }

    // If parentId points to a skipped node, resolve to the actual ancestor.
    while (parentId && skippedParentMap.current[parentId]) {
      parentId = skippedParentMap.current[parentId];
    }

    // Initialize main session on first event
    if (!mainSessionKey.current) {
      mainSessionKey.current = eventSessionKey;
    }

    // Determine if this event belongs to a subagent
    const isMainSession = eventSessionKey === mainSessionKey.current;
    
    // Get or create session chain state
    const getSessionChain = (sessKey, defaultParent = 'main') => {
      if (!sessionChains.current[sessKey]) {
        sessionChains.current[sessKey] = {
          lastChainNode: defaultParent,
          currentToolBatch: null,
        };
      }
      return sessionChains.current[sessKey];
    };

    // Track if this is a subagent node creation (not update)
    let isSubagentNode = false;
    
    // Handle subagent node creation - it becomes its own center, no connection to main
    // Only set isSubagentNode for spawned events (not completed/update events)
    if (nodeType === 'subagent' && event.type === 'subagent.spawned') {
      const mainChain = getSessionChain(mainSessionKey.current);
      parentId = mainChain.lastChainNode; // Used to determine direction, but no edge will be created
      isSubagentNode = true;
    }

    // Track if this is a user message that starts a new chain
    let startsNewChain = false;

    // Handle message nodes - skip empty messages (internal state events)
    if (nodeType === 'message') {
      const content = event.data?.content;
      const role = event.data?.role;
      
      // Skip messages without actual content (internal events)
      if (!content && event.type !== 'message.received') {
        return;
      }
      
      const isUserMessage = event.type === 'message.received';
      const isSystemMessageSent = event.data?.system === true && event.type === 'message.sent';
      
      if (isMainSession) {
        const chain = getSessionChain(eventSessionKey);
        if (isUserMessage) {
          // User message in main session: connect to main, start a new chain
          parentId = 'main';
          chain.currentToolBatch = null;
          startsNewChain = true; // This will create a new radial chain
        } else if (isSystemMessageSent) {
          // System message reply (after subagent announce): connect to the last subagent node
          // Find the most recent subagent node
          const subagentIds = Object.keys(subagentCenters.current);
          if (subagentIds.length > 0) {
            parentId = subagentIds[subagentIds.length - 1];
          } else {
            parentId = chain.lastChainNode;
          }
        } else {
          // AI response: connect to the last node in the chain
          parentId = chain.lastChainNode;
        }
      } else {
        // Message in subagent session
        const chain = getSessionChain(eventSessionKey);
        // First message in subagent should connect to the subagent node
        // Find which subagent this session belongs to
        let subagentNodeId = null;
        for (const [nodeIdKey, sessKey] of Object.entries(subagentToSession.current)) {
          if (sessKey === eventSessionKey) {
            subagentNodeId = nodeIdKey;
            break;
          }
        }
        
        if (chain.lastChainNode === 'main' && subagentNodeId) {
          // First event in this subagent session, connect to subagent node
          parentId = subagentNodeId;
        } else if (chain.lastChainNode !== 'main') {
          parentId = chain.lastChainNode;
        } else {
          // Fallback: try to find subagent from event's parentId chain
          parentId = chain.lastChainNode;
        }
        
        // In subagent, every message starts a new tool batch (each "thought" is independent)
        chain.currentToolBatch = null;
      }
    }

    // For tool nodes, merge all consecutive tools into a single batch node.
    if (nodeType === 'tool') {
      const chain = getSessionChain(eventSessionKey);
      let batchNodeId = chain.currentToolBatch;
      const isNewBatch = !batchNodeId;
      
      // Connect batch to the last chain node (user message or previous batch)
      let batchParentId = chain.lastChainNode || 'main';
      
      // For subagent sessions, find the subagent node if lastChainNode is still 'main'
      if (!isMainSession && batchParentId === 'main') {
        for (const [nodeIdKey, sessKey] of Object.entries(subagentToSession.current)) {
          if (sessKey === eventSessionKey) {
            batchParentId = nodeIdKey;
            break;
          }
        }
      }
      
      if (isNewBatch) {
        // Use first tool's nodeId for stable batch ID (survives refresh/replay)
        batchNodeId = `toolbatch:${nodeId}`;
        chain.currentToolBatch = batchNodeId;
        toolBatchData.current[batchNodeId] = {
          tools: [],
          runningCount: 0,
          errorCount: 0,
          startedAt: event.ts,
          finishedAt: null,
          parentId: batchParentId,
        };
      }

      const batch = toolBatchData.current[batchNodeId];
      const toolName = event.data?.tool_name || 'tool';
      
      // Track individual tools in the batch
      let toolEntry = batch.tools.find(t => t.nodeId === nodeId);
      if (!toolEntry) {
        toolEntry = { nodeId, name: toolName, status: 'running', data: event.data };
        batch.tools.push(toolEntry);
        batch.runningCount++;
      }

      // Update tool status
      if (event.type.endsWith('.started')) {
        toolEntry.status = 'running';
      }
      if (event.type.endsWith('.finished') || event.type.endsWith('.completed')) {
        const wasRunning = toolEntry.status === 'running';
        toolEntry.status = event.data?.status || 'ok';
        toolEntry.data = { ...toolEntry.data, ...event.data };
        if (wasRunning) batch.runningCount--;
        if (toolEntry.status === 'error') batch.errorCount++;
        
        // Update finishedAt when all tools are done (but don't delete mapping yet)
        if (batch.runningCount === 0) {
          batch.finishedAt = event.ts;
        }
      }
      if (event.type === 'error.raised') {
        toolEntry.status = 'error';
        batch.errorCount++;
      }

      // Store events under the batch node id
      if (!eventsRef.current[batchNodeId]) {
        eventsRef.current[batchNodeId] = [];
      }
      eventsRef.current[batchNodeId].push(event);

      // Build batch node info
      const batchStatus = batch.runningCount > 0 ? 'running' : (batch.errorCount > 0 ? 'error' : 'ok');
      const batchTitle = `Tools (${batch.tools.length})`;

      const batchInfo = {
        nodeId: batchNodeId,
        nodeType: 'toolbatch',
        status: batchStatus,
        title: batchTitle,
        data: { tools: batch.tools },
        startedAt: batch.startedAt,
        finishedAt: batch.finishedAt,
      };
      nodeInfoRef.current[batchNodeId] = batchInfo;

      // Determine if this tool batch belongs to a subagent
      let toolBatchSubagent = null;
      if (!isMainSession) {
        for (const [subNodeId, sessKey] of Object.entries(subagentToSession.current)) {
          if (sessKey === eventSessionKey) {
            toolBatchSubagent = subNodeId;
            break;
          }
        }
      }

      // Update or create the batch node in the graph
      setNodes((current) => {
        const exists = current.find((node) => node.id === batchNodeId);
        if (!exists) {
          // Use radial layout for tool batch nodes
          const position = addNodeToRadialLayout(batchNodeId, 'toolbatch', edgeParentId, false, false, toolBatchSubagent);
          positionRef.current[batchNodeId] = position;

          return [
            ...current,
            {
              id: batchNodeId,
              type: 'smart',
              position,
              data: {
                label: batchTitle,
                status: batchStatus,
                nodeType: 'toolbatch',
                onSelect: () => setSelectedId(batchNodeId),
              },
              style: {
                background: 'var(--node-bg)',
                color: 'var(--node-text)',
                border: `2px solid ${NODE_COLORS.tool}`,
                width: '80px',
                height: '80px',
                borderRadius: '50%',
                boxShadow: 'var(--node-shadow)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                fontSize: '12px',
              },
            },
          ];
        }

        return current.map((node) => {
          if (node.id !== batchNodeId) return node;
          return {
            ...node,
            data: {
              ...node.data,
              label: batchTitle,
              status: batchStatus,
              onSelect: () => setSelectedId(batchNodeId),
            },
          };
        });
      });

      // Create edge from parent to batch node
      const edgeParentId = batch.parentId || 'main';
      if (isNewBatch) {
        setEdges((current) => {
          const edgeId = `${edgeParentId}-${batchNodeId}`;
          if (current.find((edge) => edge.id === edgeId)) return current;

          return [
            ...current,
            {
              id: edgeId,
              source: edgeParentId,
              target: batchNodeId,
              sourceHandle: 'source-center',
              targetHandle: 'target-center',
              type: 'straight',
              animated: true,
              style: { stroke: '#94a3b8', strokeWidth: 1.4 },
            },
          ];
        });
      }

      // Update edge animation based on batch status
      if (edgeParentId) {
        setEdges((current) =>
          current.map((edge) => {
            if (edge.target !== batchNodeId) return edge;
            return {
              ...edge,
              animated: batchStatus === 'running',
              style: {
                ...edge.style,
                stroke: batchStatus === 'error' ? '#e35d6a' : '#94a3b8',
              },
            };
          })
        );
      }

      // Update last chain node to this batch
      chain.lastChainNode = batchNodeId;
      
      return; // Done handling tool event
    }

    // Non-tool nodes: original logic
    if (!eventsRef.current[nodeId]) {
      eventsRef.current[nodeId] = [];
    }
    eventsRef.current[nodeId].push(event);

    const nodeInfo = nodeInfoRef.current[nodeId] || {
      nodeId,
      nodeType,
      status: 'idle',
      title: titleForEvent(event),
      data: {},
      startedAt: null,
      finishedAt: null,
    };

    nodeInfo.title = titleForEvent(event);
    nodeInfo.data = { ...nodeInfo.data, ...event.data };

    if (event.type.endsWith('.started')) {
      nodeInfo.status = 'running';
      nodeInfo.startedAt = event.ts;
    }
    if (event.type.endsWith('.finished') || event.type.endsWith('.completed')) {
      nodeInfo.status = event.data?.status || 'ok';
      nodeInfo.finishedAt = event.ts;
    }
    if (event.type === 'message.received') {
      nodeInfo.status = 'received';
      nodeInfo.startedAt = event.ts;

      // Also append to chat log when it belongs to the currently selected UI session.
      // Skip during replay because history is loaded separately.
      // Skip system messages (subagent announces) - main agent's reply shown via message.sent
      const currentSessionKey = sessionKeyRef.current; // Use ref to get latest value
      const isSystemMessage = event.data?.system === true;
      const matchesSession = event.sessionKey === currentSessionKey;
      
      if (!replayingRef.current && matchesSession && !isSystemMessage) {
        const content = event.data?.content;
        const clientMessageId = event.data?.metadata?.clientMessageId;
        if (content) {
          setChatMessages((cur) => {
            if (clientMessageId && pendingClientIdsRef.current[clientMessageId]) {
              // We already rendered this message optimistically.
              delete pendingClientIdsRef.current[clientMessageId];
              return cur;
            }
            return [...cur, { role: 'user', content, ts: event.ts, id: event.eventId }];
          });
        }
      }
    }
    
    // Handle assistant replies (message.sent events)
    if (event.type === 'message.sent') {
      nodeInfo.status = 'sent';
      nodeInfo.startedAt = event.ts;
      
      const currentSessionKey = sessionKeyRef.current; // Use ref to get latest value
      const isSystemMessage = event.data?.system === true;
      const matchesSession = event.sessionKey === currentSessionKey;
      
      // Append assistant reply to chat log for system message responses
      // (Regular chat responses are handled via /api/chat response)
      if (!replayingRef.current && matchesSession && isSystemMessage) {
        const content = event.data?.content;
        if (content) {
          setChatMessages((cur) => [
            ...cur,
            { role: 'assistant', content, ts: event.ts, id: event.node?.nodeId || `sent-${Date.now()}` }
          ]);
        }
      }
    }
    
    if (event.type === 'error.raised') {
      nodeInfo.status = 'error';
    }

    nodeInfoRef.current[nodeId] = nodeInfo;

    // Update last chain node for message and subagent nodes
    if (nodeType === 'message' || nodeType === 'subagent') {
      const chain = getSessionChain(isMainSession ? eventSessionKey : eventSessionKey);
      chain.lastChainNode = nodeId;
      
      // For subagent nodes, also record the mapping and initialize its session
      if (nodeType === 'subagent') {
        // The subagent will have its own sessionKey for internal events
        // We'll detect this when we see events with a different sessionKey
        // For now, check if event.data has a sessionKey or task_id
        const subagentSessionKey = event.data?.sessionKey || event.data?.task_id || `subagent:${nodeId}`;
        subagentToSession.current[nodeId] = subagentSessionKey;
        // Initialize the subagent's chain with this node as the starting point
        sessionChains.current[subagentSessionKey] = {
          lastChainNode: nodeId,
          currentToolBatch: null,
        };
        // Also update main session chain so next events connect to subagent
        const mainChain = getSessionChain(mainSessionKey.current);
        mainChain.lastChainNode = nodeId;
      }
    }

    // Determine if this node belongs to a subagent (for layout purposes)
    let belongsToSubagent = null;
    if (!isMainSession) {
      for (const [subNodeId, sessKey] of Object.entries(subagentToSession.current)) {
        if (sessKey === eventSessionKey) {
          belongsToSubagent = subNodeId;
          break;
        }
      }
    }
    // System message replies should also be placed in subagent's layout
    if (isMainSession && event.data?.system === true && event.type === 'message.sent') {
      const subagentIds = Object.keys(subagentCenters.current);
      if (subagentIds.length > 0) {
        belongsToSubagent = subagentIds[subagentIds.length - 1];
      }
    }

    setNodes((current) => {
      const exists = current.find((node) => node.id === nodeId);
      if (!exists) {
        // Use radial layout
        const position = addNodeToRadialLayout(nodeId, nodeType, parentId, startsNewChain, isSubagentNode, belongsToSubagent);
        positionRef.current[nodeId] = position;

        return [
          ...current,
          {
            id: nodeId,
            type: 'smart',
            position,
            data: {
              label: buildNodeLabel(nodeInfo),
              status: nodeInfo.status,
              nodeType: nodeInfo.nodeType,
              onSelect: () => setSelectedId(nodeId),
            },
            style: {
              background: 'var(--node-bg)',
              color: 'var(--node-text)',
              border: `2px solid ${NODE_COLORS[nodeInfo.nodeType] || '#64748b'}`,
              width: '80px',
              height: '80px',
              borderRadius: '50%',
              boxShadow: 'var(--node-shadow)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              fontSize: '12px',
            },
          },
        ];
      }

      return current.map((node) => {
        if (node.id !== nodeId) return node;
        return {
          ...node,
          data: {
            ...node.data,
            label: buildNodeLabel(nodeInfo),
            status: nodeInfo.status,
            onSelect: () => setSelectedId(nodeId),
          },
          style: {
            ...node.style,
            border: `2px solid ${NODE_COLORS[nodeInfo.nodeType] || '#64748b'}`,
          },
        };
      });
    });

    // Don't create edges for subagent center nodes (they are independent)
    if (parentId && !isSubagentNode) {
      // For message nodes inside subagent, connect from subagent center (they start new chains)
      let edgeSource = parentId;
      if (belongsToSubagent && nodeType === 'message') {
        edgeSource = belongsToSubagent; // Connect from subagent center
      }
      
      setEdges((current) => {
        const edgeId = `${edgeSource}-${nodeId}`;

        // If the edge already exists, keep it but update animation/style based on latest status.
        const existing = current.find((edge) => edge.id === edgeId);
        if (existing) {
          const animated = nodeInfo.status === 'running';
          const stroke = nodeInfo.status === 'error' ? '#e35d6a' : '#94a3b8';
          return current.map((edge) =>
            edge.id === edgeId
              ? {
                  ...edge,
                  animated,
                  style: {
                    ...edge.style,
                    stroke,
                  },
                }
              : edge
          );
        }

        const stroke = nodeInfo.status === 'error' ? '#e35d6a' : '#94a3b8';

        return [
          ...current,
          {
            id: edgeId,
            source: edgeSource,
            target: nodeId,
            sourceHandle: 'source-center',
            targetHandle: 'target-center',
            type: 'straight',
            animated: nodeInfo.status === 'running',
            style: {
              stroke,
              strokeWidth: 1.4,
            },
          },
        ];
      });
    }
  };

  useEffect(() => {
    try {
      localStorage.setItem('inspectorOpen', String(inspectorOpen));
      localStorage.setItem('inspectorWidth', String(inspectorWidth));
    } catch {
      // ignore
    }
  }, [inspectorOpen, inspectorWidth]);

  useEffect(() => {
    try {
      localStorage.setItem('theme', theme);
    } catch {
      // ignore
    }
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    sessionKeyRef.current = sessionKey; // Keep ref in sync for event handlers
    try {
      localStorage.setItem('lastSessionKey', sessionKey);
    } catch {
      // ignore
    }
  }, [sessionKey]);

  // Persist node positions (layout) per session.
  useEffect(() => {
    if (!sessionKey) return;

    const timer = window.setTimeout(() => {
      try {
        const layout = {
          positions: {},
          radialData: {
            conversationChains: conversationChains.current,
            nodeToChain: nodeToChain.current,
            nodeDepthInChain: nodeDepthInChain.current,
            subagentCenters: subagentCenters.current,
            nodeToSubagent: nodeToSubagent.current,
          },
          // Save full node and edge data for stable restore
          savedNodes: nodes.map(n => ({
            id: n.id,
            type: n.type,
            position: n.position,
            data: n.data,
            style: n.style,
          })),
          savedEdges: edges.map(e => ({
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle,
            targetHandle: e.targetHandle,
            style: e.style,
            animated: e.animated,
          })),
        };
        for (const n of nodes) {
          if (!n?.id || !n?.position) continue;
          layout.positions[n.id] = { x: n.position.x, y: n.position.y };
        }
        fetch('/api/layout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionKey, layout }),
        }).catch(() => {});
      } catch {
        // ignore
      }
    }, 400);

    return () => window.clearTimeout(timer);
  }, [nodes, edges, sessionKey]);

  useEffect(() => {
    const onMove = (e) => {
      if (!resizingRef.current) return;
      const min = 260;
      const max = Math.min(900, window.innerWidth - 240);
      const next = Math.max(min, Math.min(max, window.innerWidth - e.clientX));
      setInspectorWidth(next);
    };

    const onUp = () => {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startResize = (e) => {
    if (!inspectorOpen) return;
    resizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };

  const sendChatNow = async (payload) => {
    const { text, file, clientMessageId } = payload;

    setChatBusy(true);
    setChatError(null);
    setChatStream('');
    setChatStreamStartedAt(Date.now());

    try {
      let res;
      if (file) {
        const form = new FormData();
        form.append('text', text);
        form.append('sessionKey', sessionKey);
        form.append('clientMessageId', clientMessageId);
        form.append('image', file);
        res = await fetch('/api/chat', { method: 'POST', body: form });
      } else {
        res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, sessionKey, clientMessageId }),
        });
      }

      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setChatMessages((cur) => [
        ...cur,
        { role: 'assistant', content: data.response || '', ts: new Date().toISOString(), id: `asst-${Date.now()}` },
      ]);
    } finally {
      setChatBusy(false);
      setChatStream(null);
      setChatStreamStartedAt(null);

      // Auto-flush queue
      setChatQueue((cur) => {
        if (cur.length === 0) return cur;
        const [next, ...rest] = cur;
        // Fire and forget
        sendChatNow(next);
        return rest;
      });
    }
  };

  const sendChat = async () => {
    const text = chatInput.trim();
    const file = fileInputRef.current?.files?.[0] || null;
    if (!text && !file) return;

    // /new shortcut: create a new session (button does the same thing).
    if (text === '/new' && !file) {
      setChatInput('');
      await createNewSession();
      return;
    }

    const clientMessageId = generateUUID();

    // Optimistic UI: append user message immediately.
    const optimisticText = text || (file ? '[image]' : '');
    const optimisticId = `u-${clientMessageId}`;
    pendingClientIdsRef.current[clientMessageId] = optimisticId;
    if (optimisticText) {
      setChatMessages((cur) => [
        ...cur,
        { role: 'user', content: optimisticText, ts: new Date().toISOString(), id: optimisticId },
      ]);
    }

    // Clear compose box immediately (OpenClaw-style).
    setChatInput('');
    if (fileInputRef.current) fileInputRef.current.value = '';

    const payload = { text, file, clientMessageId };

    // Queue if busy, otherwise send now.
    if (chatBusy) {
      setChatQueue((cur) => [...cur, payload]);
      return;
    }

    try {
      await sendChatNow(payload);
    } catch (e) {
      setChatError(String(e?.message || e));
    }
  };

  return (
    <div className="app-shell">
      <div className="header">
        <div>
          <p className="eyebrow">Nanobot UI</p>
          <h1>Agent Node Panel</h1>
        </div>
        <div className="header-actions">
          <button
            className="toggle-inspector"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
          <button
            className="toggle-inspector"
            onClick={() => setInspectorOpen((v) => !v)}
            title={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
          >
            {inspectorOpen ? 'Hide panel' : 'Show panel'}
          </button>
          <button
            className="toggle-inspector"
            onClick={async () => {
              // Force relayout by replaying telemetry
              await loadSession(sessionKey, true);
            }}
            title="Recalculate node positions"
          >
            Relayout
          </button>
          <button
            className="toggle-inspector"
            onClick={() => {
              try {
                const layout = {
                  positions: {},
                  radialData: {
                    conversationChains: conversationChains.current,
                    nodeToChain: nodeToChain.current,
                    nodeDepthInChain: nodeDepthInChain.current,
                    subagentCenters: subagentCenters.current,
                    nodeToSubagent: nodeToSubagent.current,
                  },
                  savedNodes: nodes.map(n => ({
                    id: n.id,
                    type: n.type,
                    position: n.position,
                    data: n.data,
                    style: n.style,
                  })),
                  savedEdges: edges.map(e => ({
                    id: e.id,
                    source: e.source,
                    target: e.target,
                    sourceHandle: e.sourceHandle,
                    targetHandle: e.targetHandle,
                    style: e.style,
                    animated: e.animated,
                  })),
                };
                for (const n of nodes) {
                  if (!n?.id || !n?.position) continue;
                  layout.positions[n.id] = { x: n.position.x, y: n.position.y };
                }
                fetch('/api/layout', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sessionKey, layout }),
                }).then(() => {
                  console.log('Layout saved');
                }).catch((e) => {
                  console.error('Save failed', e);
                });
              } catch (e) {
                console.error('Save error', e);
              }
            }}
            title="Save current layout"
          >
            Save
          </button>

          <select
            className="toggle-inspector"
            value={sessionKey}
            onChange={async (e) => {
              const key = e.target.value;
              setSessionKey(key);
              await loadSession(key);
            }}
            title="Session"
          >
            <option value={sessionKey}>{sessionKey}</option>
            {availableSessions
              .map((s) => s.key)
              .filter((k) => k && k !== sessionKey)
              .map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
          </select>

          <button className="toggle-inspector" onClick={createNewSession} title="New Session (/new)">
            New
          </button>

          <button
            className="toggle-inspector"
            onClick={async () => {
              const ok = window.confirm('Clear ALL history? This will delete all UI sessions, graphs, and layouts.');
              if (!ok) return;
              await fetch('/api/clear_all', { method: 'POST' }).catch(() => {});
              try {
                localStorage.removeItem('lastSessionKey');
              } catch {
                // ignore
              }
              setSessionKey('ui:main');
              await refreshSessionsList('ui:main');
              await loadSession('ui:main');
            }}
            title="Clear all history"
          >
            Clear
          </button>

          <div className="status-pill" style={{ cursor: 'pointer' }} onClick={() => setSelectedId('main')}>
            <span className="dot" />
            Live Telemetry · {sessionKey} · Selected: {selectedId}
          </div>
        </div>
      </div>
      <div
        className="main-grid"
        style={{
          gridTemplateColumns: inspectorOpen
            ? `minmax(0, 1fr) 10px ${inspectorWidth}px`
            : 'minmax(0, 1fr) 0px 0px',
        }}
      >
        <div className="graph-panel">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={{ smart: SmartNode }}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeMouseDown={(_, node) => setSelectedId(node.id)}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onNodeDoubleClick={(_, node) => setSelectedId(node.id)}
            onNodeDragStart={(_, node) => setSelectedId(node.id)}
            onSelectionChange={({ nodes: selNodes }) => {
              if (selNodes && selNodes.length > 0) setSelectedId(selNodes[0].id);
            }}
            nodeClickDistance={25}
            elementsSelectable
            nodesFocusable
            nodesConnectable={false}
            selectNodesOnDrag={false}
            minZoom={0.001}
            maxZoom={64}
            fitView
          >
            <Background gap={20} size={1} color="#1f2937" />
            <MiniMap
              nodeColor={(node) => NODE_COLORS[node.data?.nodeType] || '#64748b'}
              maskColor="rgba(2, 6, 23, 0.6)"
            />
            <Controls />
          </ReactFlow>
        </div>
        <div
          className={`splitter ${inspectorOpen ? '' : 'splitter-hidden'}`}
          onMouseDown={startResize}
          title="Drag to resize panel"
          role="separator"
        />
        <aside className={`inspector ${inspectorOpen ? '' : 'inspector-hidden'}`}>
          <h2>Inspector</h2>

          {selectedId === 'main' && (
            <div className="inspect-card">
              <div className="inspect-header">
                <div>
                  <p className="eyebrow">chat</p>
                  <h3>Chat (UI)</h3>
                </div>
                <span
                  className="status"
                  style={{
                    background: chatBusy ? STATUS_COLORS.running : STATUS_COLORS.idle,
                  }}
                >
                  {chatBusy ? 'running' : 'idle'}
                </span>
              </div>

              <div className="chat-panel">
                <div className="chat-log">
                  {chatMessages.length === 0 && (
                    <div className="empty-state" style={{ padding: 0 }}>
                      <p className="muted">Type a message and send it. Telemetry nodes will appear on the left.</p>
                    </div>
                  )}

                  {chatMessages.map((m) => {
                    const who = m.role === 'assistant' ? 'Agent' : 'User';
                    const side = m.role === 'assistant' ? 'left' : 'right';
                    return (
                      <div className={`chat-row ${side}`} key={m.id}>
                        <div className="chat-bubble">
                          <div className="chat-meta">
                            <span className="chat-name">{who}</span>
                            <span className="chat-time">{formatTime(m.ts)}</span>
                          </div>
                          <div className="chat-text">{m.content}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="chat-input">
                  <textarea
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Type your message..."
                    rows={3}
                  />
                  <div className="chat-actions">
                    <input ref={fileInputRef} type="file" accept="image/*" />
                    <button onClick={sendChat} disabled={false}>
                      {chatBusy ? `Queue (${chatQueue.length})` : 'Send'}
                    </button>
                  </div>
                  {chatError && <p className="chat-error">{chatError}</p>}
                </div>
              </div>
            </div>
          )}

          {selectedId !== 'main' && !selectedNode && (
            <div className="empty-state">
              <p>Select a node to inspect details.</p>
              <p className="muted">Events will appear in real time as the agent works.</p>
            </div>
          )}

          {selectedId !== 'main' && selectedNode && (
            <div className="inspect-card">
              <div className="inspect-header">
                <div>
                  <p className="eyebrow">{selectedNode.nodeType}</p>
                  <h3>{selectedNode.title}</h3>
                </div>
                <span
                  className="status"
                  style={{
                    background: STATUS_COLORS[selectedNode.status] || STATUS_COLORS.idle,
                  }}
                >
                  {selectedNode.status}
                </span>
              </div>
              <div className="inspect-meta">
                <div>
                  <span>Started</span>
                  <strong>{formatTime(selectedNode.startedAt) || '—'}</strong>
                </div>
                <div>
                  <span>Finished</span>
                  <strong>{formatTime(selectedNode.finishedAt) || '—'}</strong>
                </div>
                <div>
                  <span>Duration</span>
                  <strong>{msDiff(selectedNode.startedAt, selectedNode.finishedAt) || '—'}</strong>
                </div>
              </div>

              {selectedNode.nodeType === 'subagent' && (
                <div className="inspect-body subagent-transcript">
                  <h4>Transcript</h4>
                  <div className="chat-panel">
                    <div className="chat-log">
                    {chatStream !== null && (
                      <div className="chat-row left" key={`stream-${chatStreamStartedAt || 'live'}`}>
                        <div className="chat-bubble">
                          <div className="chat-meta">
                            <span className="chat-name">Agent</span>
                            <span className="chat-time">{formatTime(new Date(chatStreamStartedAt || Date.now()).toISOString())}</span>
                          </div>
                          <div className="chat-text">{chatStream.trim() ? chatStream : '…'}</div>
                        </div>
                      </div>
                    )}
                      {subagentTranscript.length === 0 && (
                        <div className="empty-state" style={{ padding: 0 }}>
                          <p className="muted">No subagent messages captured yet.</p>
                        </div>
                      )}

                      {subagentTranscript.map((m) => {
                        const who = m.role === 'assistant' ? 'Subagent' : 'Task';
                        const side = m.role === 'assistant' ? 'left' : 'right';
                        return (
                          <div className={`chat-row ${side}`} key={m.id}>
                            <div className="chat-bubble">
                              <div className="chat-meta">
                                <span className="chat-name">{who}</span>
                                <span className="chat-time">{formatTime(m.ts)}</span>
                              </div>
                              <div className="chat-text">{m.content}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {selectedNode.nodeType === 'subagent' ? (
                <>
                  <details className="inspect-body inspect-collapsible">
                    <summary>
                      <h4>Payload</h4>
                      <span className="muted">(collapsed)</span>
                    </summary>
                    <pre>{JSON.stringify(selectedNode.data, null, 2)}</pre>
                  </details>

                  <details className="inspect-body inspect-collapsible">
                    <summary>
                      <h4>Events</h4>
                      <span className="muted">(collapsed)</span>
                    </summary>
                    <div className="event-list">
                      {(eventsRef.current[selectedId] || []).map((event) => (
                        <div className="event-item" key={event.eventId}>
                          <div>
                            <strong>{event.type}</strong>
                            <p className="muted">{formatTime(event.ts)}</p>
                          </div>
                          <span className="event-type">{event.node?.nodeType}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                </>
              ) : (
                <>
                  <div className="inspect-body">
                    <h4>Payload</h4>
                    <pre>{JSON.stringify(selectedNode.data, null, 2)}</pre>
                  </div>
                  <div className="inspect-body">
                    <h4>Events</h4>
                    <div className="event-list">
                      {(eventsRef.current[selectedId] || []).map((event) => (
                        <div className="event-item" key={event.eventId}>
                          <div>
                            <strong>{event.type}</strong>
                            <p className="muted">{formatTime(event.ts)}</p>
                          </div>
                          <span className="event-type">{event.node?.nodeType}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

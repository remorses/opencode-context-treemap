/**
 * Visualizes context usage for a session as a treemap.
 * Each message becomes a container node, parts are children with their char sizes.
 *
 * Usage:
 *   bun run src/opencode.ts [session-id]
 *
 * Requires opencode to be running (or will start a server automatically)
 */

import path from "node:path"
import cac from "cac"
import { createOpencode, type Part, type Message, type Session } from "@opencode-ai/sdk"
import { createCliRenderer, MacOSScrollAccel } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import React, { useState } from "react"
import { Treemap, type TreeNode } from "./treeview.js"
import { Dropdown, type DropdownOption } from "./dropdown.js"

const cli = cac("opencode-treemap")

cli
  .command("[sessionId]", "Visualize context usage for a session")
  .action(async (sessionId?: string) => {
    await main(sessionId)
  })

cli.help()
cli.version("1.0.0")

cli.parse()

function getPartSize(part: Part): number {
  switch (part.type) {
    case "text":
      return part.text.length
    case "reasoning":
      return part.text.length
    case "tool":
      if (part.state.status === "completed") {
        const inputSize = JSON.stringify(part.state.input).length
        let outputSize = part.state.output.length
        // if prune compacted this tool, it will not have otuput in context
        if (part.state.time.compacted) {
          outputSize = 0
        }
        return inputSize + outputSize
      }
      if (part.state.status === "running" || part.state.status === "pending") {
        return JSON.stringify(part.state.input).length
      }
      if (part.state.status === "error") {
        return JSON.stringify(part.state.input).length + part.state.error.length
      }
      return 0
    case "file":
      if (part.source?.text) {
        return part.source.text.value.length
      }
      return part.url.length
    case "subtask":
      return part.prompt.length + part.description.length
    case "step-start":
    case "step-finish":
    case "snapshot":
    case "patch":
    case "agent":
    case "retry":
    case "compaction":
      return 0
    default:
      return 0
  }
}

function getPartLabel(part: Part, projectPath: string): string {
  const relativePath = (filePath: string) => {
    const rel = path.relative(projectPath, filePath)
    // If relative path starts with "..", the file is outside project, use absolute
    return rel.startsWith("..") ? filePath : rel
  }

  switch (part.type) {
    case "text":
      return `text`
    case "reasoning":
      return `reasoning`
    case "tool": {

      const input = "input" in part.state ? part.state.input : null
      if ((part.tool === "read" || part.tool === "write") && input && typeof input === "object" && "filePath" in input) {

        return `tool:${part.tool}:${relativePath(input.filePath as string)}`
      }
      return `tool:${part.tool}`
    }
    case "file": {
      // Use source path if available, otherwise filename or url
      const filePath = (part.source && "path" in part.source) ? part.source.path : (part.filename || part.url)
      return `file:${relativePath(filePath)}`
    }
    case "subtask":
      return `subtask:${part.agent}`
    default:
      return part.type
  }
}

function formatCharSize(chars: number): string {
  if (chars < 1000) return chars + " chars"
  const k = chars / 1000
  if (k < 1000) return k.toFixed(1) + "K chars"
  const m = k / 1000
  return m.toFixed(1) + "M chars"
}

// Color map for different part types
const colorMap: Record<string, string> = {
  // Message roles
  "user": "#4ade80",      // bright green
  "assistant": "#818cf8", // bright indigo

  // Part types
  "text": "#60a5fa",      // bright blue
  "reasoning": "#c084fc", // bright purple
  "file": "#fbbf24",      // bright amber

  // Tool types
  "tool:read": "#34d399",    // bright emerald
  "tool:write": "#f87171",   // bright red
  "tool:edit": "#fb923c",    // bright orange
  "tool:bash": "#38bdf8",    // bright sky blue
  "tool:glob": "#a3e635",    // bright lime
  "tool:grep": "#2dd4bf",    // bright teal
  "tool:list": "#facc15",    // bright yellow
  "tool:task": "#e879f9",    // bright fuchsia
  "tool:todowrite": "#a78bfa", // bright violet
  "tool:todoread": "#93c5fd",  // light blue
  "tool:webfetch": "#4ade80",  // bright green
  "tool:googlesearch": "#f472b6", // bright pink
  "tool": "#94a3b8",         // slate (fallback)

  // Other types
  "subtask": "#d946ef",   // bright magenta
  "step-start": "#64748b", // slate
  "step-finish": "#78716c", // stone
  "snapshot": "#6b7280",  // gray
  "patch": "#fb7185",     // rose
  "agent": "#a78bfa",     // violet
  "retry": "#ef4444",     // red
  "compaction": "#14b8a6", // teal
}

function getPartColorType(part: Part): string {
  if (part.type === "tool") {
    return colorMap[`tool:${part.tool}`] ? `tool:${part.tool}` : "tool"
  }
  return part.type
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }

    this.componentDidCatch = this.componentDidCatch.bind(this)
  }

  static getDerivedStateFromError(error: Error): {
    hasError: boolean
    error: Error
  } {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("Error caught by boundary:", error)
    console.error("Component stack:", errorInfo.componentStack)
  }

  override render(): any {
    if (this.state.hasError && this.state.error) {
      return React.createElement(
        "box",
        { style: { flexDirection: "column", padding: 2 } },
        React.createElement("text", { fg: "red" }, "Error: ", this.state.error.message),
        React.createElement("text", { fg: "brightBlack" }, this.state.error.stack)
      )
    }

    return this.props.children
  }
}

function formatSessionLabel(session: Session): string {
  const date = new Date(session.time.created)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return "just now"
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  return `${diffDays}d ago`
}

async function main(sessionId?: string) {
  const { client, server } = await createOpencode({port: 0})

  // If no session ID provided, show session selector
  if (!sessionId) {
    const sessionsResult = await client.session.list()

    if (!sessionsResult.data || sessionsResult.data.length === 0) {
      console.error("No sessions found for this project")
      server.close()
      process.exit(1)
    }

    const sessions = sessionsResult.data

    const options: DropdownOption[] = sessions.map((session) => ({
      title: session.title || session.id.slice(0, 8),
      value: session.id,
      label: formatSessionLabel(session),
      keywords: [session.id, session.title || ""],
    }))

    function SessionSelector() {
      const handleSelect = (selectedId: string) => {
        // Re-run main with the selected session
        renderer.destroy()
        main(selectedId)
      }

      useKeyboard((key) => {
        if (key.name === "escape") {
          renderer.destroy()
          server.close()
          process.exit(0)
        }
      })

      return React.createElement(
        "box",
        { style: { flexDirection: "column", flexGrow: 1, border: true } },
        React.createElement(Dropdown, {
          tooltip: "Select a session",
          placeholder: "Search sessions…",
          options,
          onChange: handleSelect,
        })
      )
    }

    const renderer = await createCliRenderer({
      exitOnCtrlC: true,
      useMouse: true,
      onDestroy: () => {
        server.close()
      },
    })
    createRoot(renderer).render(
      React.createElement(ErrorBoundary, null, React.createElement(SessionSelector))
    )
    return
  }

  const messagesResult = await client.session.messages({ path: { id: sessionId } })

  if (!messagesResult.data) {
    console.error("Failed to fetch messages:", messagesResult.error)
    process.exit(1)
  }

  const messages = messagesResult.data

  // Try to get session directory, but don't fail if session is from different project
  const sessionResult = await client.session.get({ path: { id: sessionId } }).catch(() => null)
  const projectPath = sessionResult?.data?.directory ?? ""

  // Create a map to store parts by key
  const partsMap = new Map<string, Part>()

  // Build tree structure: messages -> parts
  const messageNodes: TreeNode[] = messages.map((msg, msgIndex) => {
    const role = msg.info.role

    // Create a node for each part
    const children: TreeNode[] = msg.parts.map((part, partIndex) => {
      const size = getPartSize(part)
      const label = getPartLabel(part, projectPath)
      const partKey = `${msgIndex}-${partIndex}`
      partsMap.set(partKey, part)
      return {
        name: label,
        value: size,
        layer: 1,
        partKey,
        colorType: getPartColorType(part),
      }
    })

    const isLast = msgIndex === messages.length - 1
    return {
      name: `${role}:${msgIndex}${isLast ? " (last)" : ""}`,
      value: 0,
      colorType: role,
      layer: 0,
      children,
    }
  })

  const rootNode: TreeNode = {
    name: "session",
    value: 0,
    children: messageNodes,
  }

  function getPartContent(part: Part): string {
    switch (part.type) {
      case "text":
        return `=== TEXT ===\n\n${part.text}`
      case "reasoning":
        return `=== REASONING ===\n\n${part.text}`
      case "tool":
        if (part.state.status === "completed") {
          return `=== TOOL: ${part.tool} ===\n\n--- INPUT ---\n${JSON.stringify(part.state.input, null, 2)}\n\n--- OUTPUT ---\n${part.state.output}`
        }
        if (part.state.status === "error") {
          return `=== TOOL: ${part.tool} (ERROR) ===\n\n--- INPUT ---\n${JSON.stringify(part.state.input, null, 2)}\n\n--- ERROR ---\n${part.state.error}`
        }
        return `=== TOOL: ${part.tool} (${part.state.status}) ===\n\n--- INPUT ---\n${JSON.stringify(part.state.input, null, 2)}`
      case "file":
        if (part.source?.text) {
          return `=== FILE: ${part.filename || part.url} ===\n\n${part.source.text.value}`
        }
        return `=== FILE: ${part.filename || part.url} ===\n\n(no content)`
      case "subtask":
        return `=== SUBTASK: ${part.agent} ===\n\n--- DESCRIPTION ---\n${part.description}\n\n--- PROMPT ---\n${part.prompt}`
      default:
        return `=== ${part.type.toUpperCase()} ===\n\n${JSON.stringify(part, null, 2)}`
    }
  }

  function App() {
    const [selectedPart, setSelectedPart] = useState<Part | null>(null)

    useKeyboard((key) => {
      if (key.name === "escape" && selectedPart) {
        setSelectedPart(null)
      }
    })

    const handleLeafSelect = (node: TreeNode) => {
      if (node.partKey) {
        const part = partsMap.get(node.partKey)
        if (part) {
          setSelectedPart(part)
        }
      }
    }

    if (selectedPart) {
      const content = getPartContent(selectedPart)
      return React.createElement(
        "box",
        { style: { flexDirection: "column", flexGrow: 1 } },
        React.createElement(
          "box",
          { style: { height: 3, border: true, paddingLeft: 1 } },
          React.createElement("text", null, `${getPartLabel(selectedPart, projectPath)} - ${formatCharSize(getPartSize(selectedPart))} | Press ESC to close`)
        ),
        React.createElement(
          "scrollbox",
          { focused: true, style: { flexGrow: 1, border: true }, scrollAcceleration: new MacOSScrollAccel() },
          React.createElement("text", null, content)
        )
      )
    }

    return React.createElement(Treemap, {
      nodes: [
        { name: "session", data: rootNode },
      ],
      colorMap,
      formatValue: formatCharSize,
      onLeafSelect: handleLeafSelect,
    })
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: true,
    onDestroy: () => {
      server.close()
    },
  })
  createRoot(renderer).render(
    React.createElement(ErrorBoundary, null, React.createElement(App))
  )
}

/**
 * Visualizes context usage for a session as a treemap.
 * Each message becomes a container node, parts are children with their char sizes.
 *
 * Usage:
 *   bun run src/opencode.ts <session-id>
 *
 * Requires opencode to be running (or will start a server automatically)
 */

import path from "node:path"
import { createOpencode, type Part, type Message } from "@opencode-ai/sdk"
import { createCliRenderer, MacOSScrollAccel } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import React, { useState } from "react"
import { Treemap, type TreeNode } from "./treeview.js"

const sessionID = process.argv[2]

if (!sessionID) {
  console.error("Usage: bun run src/opencode.ts <session-id>")
  process.exit(1)
}

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
      return JSON.stringify(part).length
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
    case "file":
      return `file:${part.filename || part.url}`
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

const schemeBlue = [
  "#deebf7",
  "#c6dbef",
  "#9ecae1",
  "#6baed6",
  "#4292c6",
  "#2171b5",
  "#084594",
]

const schemeGreen = [
  "#e5f5e0",
  "#c7e9c0",
  "#a1d99b",
  "#74c476",
  "#41ab5d",
  "#238b45",
  "#005a32",
]

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

async function main() {
  const { client, server } = await createOpencode({port: 0})

  const messagesResult = await client.session.messages({ path: { id: sessionID! } })

  if (!messagesResult.data) {
    console.error("Failed to fetch messages:", messagesResult.error)
    process.exit(1)
  }

  const messages = messagesResult.data

  // Try to get session directory, but don't fail if session is from different project
  const sessionResult = await client.session.get({ path: { id: sessionID! } }).catch(() => null)
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
      }
    })

    const isLast = msgIndex === messages.length - 1
    return {
      name: `${role}:${msgIndex}${isLast ? " (last)" : ""}`,
      value: 0,
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
      colorScheme: schemeBlue,
      deletedColorScheme: schemeGreen,
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

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

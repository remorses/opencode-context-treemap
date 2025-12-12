/**
 * Visualizes context usage for a session as a treemap.
 * Each message becomes a container node, parts are children with their char sizes.
 *
 * Usage:
 *   bun run src/opencode.ts <session-id>
 *
 * Requires opencode to be running (or will start a server automatically)
 */

import { createOpencode, type Part, type Message } from "@opencode-ai/sdk"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import React from "react"
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
        const outputSize = part.state.output.length
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

function getPartLabel(part: Part): string {
  switch (part.type) {
    case "text":
      return `text`
    case "reasoning":
      return `reasoning`
    case "tool":
      return `tool:${part.tool}`
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
  const { client } = await createOpencode({port: 0})

  const result = await client.session.messages({
    path: { id: sessionID! },
  })

  if (!result.data) {
    console.error("Failed to fetch messages:", result.error)
    process.exit(1)
  }

  const messages = result.data

  // Build tree structure: messages -> parts grouped by type
  const messageNodes: TreeNode[] = messages.map((msg, msgIndex) => {
    const role = msg.info.role

    // Group parts by type
    const partsByType = new Map<string, { label: string; size: number }[]>()

    for (const part of msg.parts) {
      const size = getPartSize(part)
      const label = getPartLabel(part)
      const type = label.split(":")[0]

      if (!partsByType.has(type)) {
        partsByType.set(type, [])
      }
      partsByType.get(type)!.push({ label, size })
    }

    // Create children for each part type
    const children: TreeNode[] = []
    let typeLayer = 1

    for (const [type, parts] of partsByType) {
      if (parts.length === 1) {
        // Single part of this type - add directly
        children.push({
          name: parts[0].label,
          value: parts[0].size,
          layer: typeLayer,
        })
      } else {
        // Multiple parts of this type - group them
        const typeChildren: TreeNode[] = parts.map((p, i) => ({
          name: p.label === type ? `${type}[${i}]` : p.label,
          value: p.size,
          layer: typeLayer + 1,
        }))

        children.push({
          name: type,
          value: 0,
          layer: typeLayer,
          children: typeChildren,
        })
      }
      typeLayer++
    }

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

  function App() {
    return React.createElement(Treemap, {
      nodes: [
        { name: "session", data: rootNode },
      ],
      colorScheme: schemeBlue,
      deletedColorScheme: schemeGreen,
      formatValue: formatCharSize,
    })
  }

  const renderer = await createCliRenderer({exitOnCtrlC: true})
  createRoot(renderer).render(
    React.createElement(ErrorBoundary, null, React.createElement(App))
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

import * as React from "react"
import { Check, ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/utils"

export interface ComboboxOption {
  value: string
  label: string
  /** Optional category group. When any option has a group, options render in
   *  grouped sections with non-interactive headers between groups. */
  group?: string
}

interface ComboboxProps {
  options: ComboboxOption[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  className?: string
  id?: string
}

export function Combobox({
  options,
  value,
  onValueChange,
  placeholder = "Select...",
  searchPlaceholder,
  emptyText = "No results found.",
  disabled = false,
  className,
  id,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const selectedLabel = options.find((o) => o.value === value)?.label

  const filtered = search
    ? options.filter((o) =>
        o.label.toLowerCase().includes(search.toLowerCase())
      )
    : options

  React.useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch("")
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        setOpen(false)
        setSearch("")
      }
    }
    document.addEventListener("keydown", handler, true)
    return () => document.removeEventListener("keydown", handler, true)
  }, [open])

  const handleSelect = (option: ComboboxOption) => {
    onValueChange(option.value === value ? "" : option.value)
    setOpen(false)
    setSearch("")
  }

  const hasGroups = filtered.some((o) => o.group)

  const groupedOptions = React.useMemo(() => {
    if (!hasGroups) return null
    const groupMap = new Map<string, ComboboxOption[]>()
    const groupOrder: string[] = []
    for (const o of filtered) {
      const g = o.group!
      if (!groupMap.has(g)) {
        groupMap.set(g, [])
        groupOrder.push(g)
      }
      groupMap.get(g)!.push(o)
    }
    return groupOrder.map(label => ({ label, options: groupMap.get(label)! }))
  }, [filtered, hasGroups])

  return (
    <div ref={wrapperRef} className={cn("relative w-full", className)}>
      {/* Trigger: static button when closed, inline search input when open */}
      {open ? (
        <div
          className="flex h-9 w-full items-center rounded-md border border-ring bg-transparent px-3 text-sm shadow-sm ring-1 ring-ring"
        >
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchPlaceholder ?? selectedLabel ?? placeholder}
            className="h-full w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoFocus
          />
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </div>
      ) : (
        <button
          type="button"
          role="combobox"
          id={id}
          aria-expanded={false}
          disabled={disabled}
          onClick={() => { if (!disabled) setOpen(true) }}
          className={cn(
            "flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-glass-border bg-input px-3 py-2 text-sm shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            !value && "text-muted-foreground"
          )}
        >
          <span className="line-clamp-1">
            {selectedLabel ?? placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      )}

      {/* Options list — absolutely positioned overlay */}
      {open && (
        <div className="absolute left-0 top-full -mt-px z-50 w-full rounded-md border border-glass-border bg-popover text-popover-foreground shadow-md backdrop-blur-[10px] backdrop-saturate-[1.15] animate-in fade-in-0 zoom-in-95 slide-in-from-top-2">
          <div className="max-h-[200px] overflow-y-auto overflow-x-hidden p-1">
            {filtered.length === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                {emptyText}
              </div>
            ) : hasGroups && groupedOptions ? (
              groupedOptions.map((group) => (
                <div key={group.label}>
                  <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground select-none">
                    {group.label}
                  </div>
                  {group.options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => handleSelect(option)}
                      className={cn(
                        "relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground",
                        value === option.value && "bg-accent/50"
                      )}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4 shrink-0",
                          value === option.value ? "opacity-100" : "opacity-0"
                        )}
                        strokeWidth={1.5}
                      />
                      {option.label}
                    </button>
                  ))}
                </div>
              ))
            ) : (
              filtered.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSelect(option)}
                  className={cn(
                    "relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground",
                    value === option.value && "bg-accent/50"
                  )}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4 shrink-0",
                      value === option.value ? "opacity-100" : "opacity-0"
                    )}
                    strokeWidth={1.5}
                  />
                  <span className="min-w-0 truncate">{option.label}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

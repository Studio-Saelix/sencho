import * as React from "react"
import { Check, ChevronsUpDown } from "lucide-react"
import { cn } from "@/lib/utils"

export interface MultiSelectOption {
  value: string
  label: string
  color?: string
}

interface MultiSelectComboboxProps {
  options: MultiSelectOption[]
  selected: Set<string>
  onSelectionChange: (selected: Set<string>) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  className?: string
  renderOption?: (option: MultiSelectOption, isSelected: boolean) => React.ReactNode
  /** Noun used in the trigger's selected-count label, e.g. "2 nodes". Defaults to "tag". */
  selectedLabel?: string
}

export function MultiSelectCombobox({
  options,
  selected,
  onSelectionChange,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  emptyText = "No results found.",
  disabled = false,
  className,
  renderOption,
  selectedLabel = "tag",
}: MultiSelectComboboxProps) {
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const wrapperRef = React.useRef<HTMLDivElement>(null)

  const filtered = search
    ? options.filter((o) =>
        o.label.toLowerCase().includes(search.toLowerCase())
      )
    : options

  React.useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch("")
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        setOpen(false)
        setSearch("")
      }
    }
    document.addEventListener("mousedown", onMouseDown)
    document.addEventListener("keydown", onKeyDown, true)
    return () => {
      document.removeEventListener("mousedown", onMouseDown)
      document.removeEventListener("keydown", onKeyDown, true)
    }
  }, [open])

  const handleToggle = (option: MultiSelectOption) => {
    const next = new Set(selected)
    if (next.has(option.value)) {
      next.delete(option.value)
    } else {
      next.add(option.value)
    }
    onSelectionChange(next)
  }

  const triggerLabel = selected.size > 0
    ? `${selected.size} ${selectedLabel}${selected.size !== 1 ? 's' : ''}`
    : placeholder

  return (
    <div ref={wrapperRef} className={cn("relative", className)}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen(!open) }}
        className={cn(
          "flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border border-glass-border bg-input px-2.5 text-xs shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          selected.size > 0 ? "text-foreground" : "text-muted-foreground",
          open && "ring-1 ring-ring border-ring"
        )}
      >
        <span>{triggerLabel}</span>
        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
      </button>

      {open && (
        <div className="absolute left-0 top-full -mt-px z-50 min-w-[180px] rounded-md border border-glass-border bg-popover text-popover-foreground shadow-md backdrop-blur-[10px] backdrop-saturate-[1.15] animate-in fade-in-0 zoom-in-95 slide-in-from-top-2">
          {options.length > 5 && (
            <div className="p-1.5 border-b border-glass-border">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                className="h-7 w-full bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground"
                autoFocus
              />
            </div>
          )}
          <div className="max-h-[200px] overflow-y-auto overflow-x-hidden p-1">
            {filtered.length === 0 ? (
              <div className="py-3 text-center text-xs text-muted-foreground">
                {emptyText}
              </div>
            ) : (
              filtered.map((option) => {
                const isSelected = selected.has(option.value)
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleToggle(option)}
                    className={cn(
                      "relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none hover:bg-accent hover:text-accent-foreground",
                      isSelected && "bg-accent/50"
                    )}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-3.5 w-3.5 shrink-0",
                        isSelected ? "opacity-100" : "opacity-0"
                      )}
                      strokeWidth={1.5}
                    />
                    {renderOption ? renderOption(option, isSelected) : option.label}
                  </button>
                )
              })
            )}
          </div>
          {selected.size > 0 && (
            <div className="border-t border-glass-border p-1">
              <button
                type="button"
                onClick={() => onSelectionChange(new Set())}
                className="flex w-full items-center justify-center rounded-sm px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

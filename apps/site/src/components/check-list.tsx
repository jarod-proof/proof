import { StatusIcon } from "@proof/ui/dplus/status"
import { cn } from "cn"

/** A list where every item carries the done mark. */
export function CheckList({ items, className }: { items: string[]; className?: string }) {
  return (
    <ul className={cn("flex flex-col gap-2", className)}>
      {items.map((item) => (
        <li key={item} className="flex gap-2.5">
          <StatusIcon state="done" className="mt-1" />
          {item}
        </li>
      ))}
    </ul>
  )
}

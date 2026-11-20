import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

import { Button } from "@proof/ui/components/ui/button"
import { Input } from "@proof/ui/components/ui/input"
import { Textarea } from "@proof/ui/components/ui/textarea"

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "group/input-group relative flex h-11 w-full min-w-0 items-center rounded-lg border-[1.5px] border-input bg-transparent transition-[color,border-color,box-shadow] outline-none in-data-[slot=combobox-content]:focus-within:border-inherit in-data-[slot=combobox-content]:focus-within:ring-0 has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:shadow-[inset_0_0_0_0.5px_var(--ring)] has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot][aria-invalid=true]]:shadow-[inset_0_0_0_0.5px_var(--destructive)] has-[[data-slot=input-group-control]:disabled]:border-dashed has-[[data-slot=input-group-control]:disabled]:text-muted-foreground has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>textarea]:h-auto has-[>[data-align=block-end]]:[&>input]:pt-3 has-[>[data-align=block-start]]:[&>input]:pb-3",
        className,
      )}
      {...props}
    />
  )
}

const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-2 py-2 text-sm text-muted-foreground select-none group-data-[disabled=true]/input-group:text-muted-foreground **:data-[slot=kbd]:rounded-md **:data-[slot=kbd]:bg-muted-foreground/10 **:data-[slot=kbd]:px-1.5 [&>svg:not([class*='size-'])]:size-4",
  {
    variants: {
      align: {
        "inline-start": "order-first pl-3 has-[>button]:pl-1.5 has-[>kbd]:pl-2",
        "inline-end": "order-last pr-3 has-[>button]:pr-1.5 has-[>kbd]:pr-2",
        "block-start":
          "order-first w-full justify-start px-3 pt-3 group-has-[>input]/input-group:pt-3 [.border-b]:pb-3",
        "block-end":
          "order-last w-full justify-start px-3 pb-3 group-has-[>input]/input-group:pb-3 [.border-t]:pt-3",
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  },
)

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) {
          return
        }
        e.currentTarget.parentElement?.querySelector("input")?.focus()
      }}
      {...props}
    />
  )
}

const inputGroupButtonVariants = cva("flex items-center gap-2 rounded-md text-sm shadow-none", {
  variants: {
    size: {
      xs: "h-7 gap-1 rounded-md px-2 text-xs [&>svg:not([class*='size-'])]:size-3.5",
      sm: "h-8 rounded-md px-2.5",
      "icon-xs": "size-7 rounded-md p-0 text-xs has-[>svg]:p-0",
      "icon-sm": "size-8 rounded-md p-0 has-[>svg]:p-0",
    },
  },
  defaultVariants: {
    size: "xs",
  },
})

function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "xs",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "type"> &
  VariantProps<typeof inputGroupButtonVariants> & {
    type?: "button" | "submit" | "reset"
  }) {
  return (
    <Button
      type={type}
      data-size={size}
      variant={variant}
      className={cn(inputGroupButtonVariants({ size }), className)}
      {...props}
    />
  )
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 text-sm text-muted-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  )
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "h-full flex-1 rounded-none border-0 bg-transparent px-3 ring-0 focus-visible:border-0 focus-visible:px-3 aria-invalid:border-0 disabled:border-0 group-has-[>[data-align=inline-end]]/input-group:pr-2 group-has-[>[data-align=inline-start]]/input-group:pl-2 group-has-[>[data-align=inline-end]]/input-group:focus-visible:pr-2 group-has-[>[data-align=inline-start]]/input-group:focus-visible:pl-2 focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent",
        className,
      )}
      {...props}
    />
  )
}

function InputGroupTextarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <Textarea
      data-slot="input-group-control"
      className={cn(
        "flex-1 resize-none rounded-none border-0 bg-transparent px-3 py-2.5 ring-0 focus-visible:px-3 focus-visible:py-2.5 focus-visible:border-0 focus-visible:ring-0 aria-invalid:border-0 aria-invalid:ring-0",
        className,
      )}
      {...props}
    />
  )
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
}

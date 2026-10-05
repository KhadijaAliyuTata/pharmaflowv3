import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary-hover",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        // Semantic status variants. This app has real state to label (in stock /
        // expiring / on credit) and `destructive` cannot carry a positive state.
        //
        // Each pairs a *tint* background with the full-strength semantic text
        // colour rather than a `/10` background with a `/10` foreground, which is
        // how you end up with grey-on-grey pills. Text stays legible and the
        // label is always present, so state never rests on colour alone.
        success:
          "border-success-border bg-success-subtle text-success focus-visible:ring-success/20 dark:focus-visible:ring-success/40 [a]:hover:bg-success-subtle/70",
        warning:
          "border-warning-border bg-warning-subtle text-warning focus-visible:ring-warning/20 dark:focus-visible:ring-warning/40 [a]:hover:bg-warning-subtle/70",
        danger:
          "border-danger-border bg-danger-subtle text-destructive focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-danger-subtle/70",
        info: "border-info-border bg-info-subtle text-info focus-visible:ring-info/20 dark:focus-visible:ring-info/40 [a]:hover:bg-info-subtle/70",
        neutral:
          "border-border bg-muted text-muted-foreground focus-visible:ring-ring/30 [a]:hover:bg-muted/70",
        brand: "border-navy-border bg-navy-soft text-navy dark:border-navy-border dark:bg-navy-soft dark:text-brand-navy",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }

import type { AnchorHTMLAttributes } from "react";
import { navigate } from "./next-navigation";

export default function Link({ href, scroll: _scroll, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; scroll?: boolean }) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
        navigate(href);
      }}
    />
  );
}

import { Thumbnail } from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";

export function Thumb({ src, alt, size = "small" }: { src: string | null | undefined; alt: string; size?: "extraSmall" | "small" | "medium" | "large" }) {
  return <Thumbnail source={src || ImageIcon} alt={alt} size={size} />;
}

"use client";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

interface ImageLightboxProps {
  src: string | null;
  alt?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Full-size, in-page preview viewer. Renders the image at native size capped
 * to the viewport (object-contain). Dismiss via the close button, Esc, or by
 * clicking the overlay.
 */
export function ImageLightbox({
  src,
  alt = "",
  open,
  onOpenChange,
}: ImageLightboxProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-auto max-w-[95vw] border-0 bg-transparent p-0 shadow-none sm:max-w-[90vw]">
        <DialogTitle className="sr-only">Enlarged preview image</DialogTitle>
        {src && (
          <img
            src={src}
            alt={alt}
            className="mx-auto max-h-[88vh] w-auto max-w-full rounded-lg object-contain"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

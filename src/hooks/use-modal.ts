"use client";

import { useState, useCallback } from "react";

export function useModal<T = undefined>() {
  const [isOpen, setIsOpen] = useState(false);
  const [data, setData] = useState<T | undefined>(undefined);

  const onOpen = useCallback((itemData?: T) => {
    setData(itemData);
    setIsOpen(true);
  }, []);

  const onClose = useCallback(() => {
    setIsOpen(false);
    setData(undefined);
  }, []);

  return { isOpen, data, onOpen, onClose };
}

"use client";

import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface CreatorFilterProps {
  creators: string[];
  value: string; // active creator, "" when none
  onChange: (creator: string) => void; // "" clears the filter
}

export function CreatorFilter({ creators, value, onChange }: CreatorFilterProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-[200px] justify-between"
        >
          <span className="truncate">{value || "All Creators"}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search creators..." className="h-9" />
          <CommandList>
            <CommandEmpty>No creators found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__all__"
                onSelect={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                <Check
                  className={cn("mr-2 h-4 w-4", value === "" ? "opacity-100" : "opacity-0")}
                />
                All Creators
              </CommandItem>
              {creators.map((creator) => (
                <CommandItem
                  key={creator}
                  value={creator}
                  onSelect={() => {
                    onChange(creator);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === creator ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="truncate">{creator}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

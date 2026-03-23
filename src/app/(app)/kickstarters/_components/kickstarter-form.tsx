"use client";

import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { kickstarterSchema, type KickstarterInput } from "@/schemas/kickstarter.schema";
import { createKickstarter, updateKickstarter, createHost } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface HostOption {
  id: string;
  name: string;
  _count: { kickstarters: number };
}

interface KickstarterFormProps {
  kickstarter?: {
    id: string;
    name: string;
    link: string | null;
    filesUrl: string | null;
    deliveryStatus: "NOT_DELIVERED" | "PARTIAL" | "DELIVERED";
    paymentStatus: "PAID" | "UNPAID";
    hostId: string | null;
    notes: string | null;
  };
  hosts: HostOption[];
  onSuccess: () => void;
}

export function KickstarterForm({ kickstarter, hosts, onSuccess }: KickstarterFormProps) {
  const [isPending, startTransition] = useTransition();
  const [hostList, setHostList] = useState(hosts);
  const [showNewHost, setShowNewHost] = useState(false);
  const [newHostName, setNewHostName] = useState("");
  const isEditing = !!kickstarter;

  const form = useForm<KickstarterInput>({
    resolver: zodResolver(kickstarterSchema),
    defaultValues: {
      name: kickstarter?.name ?? "",
      link: kickstarter?.link ?? "",
      filesUrl: kickstarter?.filesUrl ?? "",
      deliveryStatus: kickstarter?.deliveryStatus ?? "NOT_DELIVERED",
      paymentStatus: kickstarter?.paymentStatus ?? "UNPAID",
      hostId: kickstarter?.hostId ?? "",
      notes: kickstarter?.notes ?? "",
    },
  });

  function onSubmit(values: KickstarterInput) {
    startTransition(async () => {
      const result = isEditing
        ? await updateKickstarter(kickstarter!.id, values)
        : await createKickstarter(values);

      if (!result.success) {
        toast.error(result.error);
        return;
      }

      toast.success(isEditing ? "Kickstarter updated" : "Kickstarter created");
      form.reset();
      onSuccess();
    });
  }

  function handleAddHost() {
    if (!newHostName.trim()) return;
    startTransition(async () => {
      const result = await createHost({ name: newHostName.trim() });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(`Host "${result.data!.name}" created`);
      setHostList((prev) => [
        ...prev,
        { id: result.data!.id, name: result.data!.name, _count: { kickstarters: 0 } },
      ]);
      form.setValue("hostId", result.data!.id);
      setNewHostName("");
      setShowNewHost(false);
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="Kickstarter name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="link"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Link</FormLabel>
              <FormControl>
                <Input placeholder="https://kickstarter.com/..." {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="filesUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Files URL</FormLabel>
              <FormControl>
                <Input placeholder="https://drive.google.com/..." {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="deliveryStatus"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Delivery Status</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="NOT_DELIVERED">Not Delivered</SelectItem>
                    <SelectItem value="PARTIAL">Partial</SelectItem>
                    <SelectItem value="DELIVERED">Delivered</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="paymentStatus"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Payment Status</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="PAID">Paid</SelectItem>
                    <SelectItem value="UNPAID">Unpaid</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="hostId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Host</FormLabel>
              {!showNewHost ? (
                <div className="flex gap-2">
                  <Select
                    onValueChange={(v) => field.onChange(v === "none" ? "" : v)}
                    defaultValue={field.value || "none"}
                  >
                    <FormControl>
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select host (optional)" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">No Host</SelectItem>
                      {hostList.map((host) => (
                        <SelectItem key={host.id} value={host.id}>
                          {host.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setShowNewHost(true)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Input
                    placeholder="New host name"
                    value={newHostName}
                    onChange={(e) => setNewHostName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddHost();
                      }
                      if (e.key === "Escape") {
                        setShowNewHost(false);
                        setNewHostName("");
                      }
                    }}
                    autoFocus
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAddHost}
                    disabled={isPending || !newHostName.trim()}
                  >
                    Add
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowNewHost(false);
                      setNewHostName("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notes</FormLabel>
              <FormControl>
                <Textarea placeholder="Optional notes" rows={3} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : isEditing ? "Update" : "Create"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

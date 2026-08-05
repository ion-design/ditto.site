import { z } from "zod";
import { validateIonClonePlan } from "@cloner/core";

const SafeRoute = z.string().min(1);

export const ExperimentalClonePlanSchema = z
  .object({
    version: z.literal("ion-clone-plan-v1"),
    entryRoute: SafeRoute,
    staticRoutes: z.array(SafeRoute),
    manifests: z.array(
      z
        .object({
          key: z.string().min(1),
          entityType: z.string().min(1),
        })
        .strict(),
    ),
    renderers: z.array(
      z
        .object({
          key: z.string().min(1),
          role: z.enum(["index", "listing", "detail"]),
          pattern: SafeRoute,
          captureUrl: SafeRoute.optional(),
          manifestKeys: z.array(z.string().min(1)),
          reuseRendererKey: z.string().min(1).optional(),
          aliases: z.array(SafeRoute).optional(),
        })
        .strict(),
    ),
    dispositions: z.array(
      z
        .object({
          path: SafeRoute,
          kind: z.enum(["static", "renderer", "passthrough", "ignored"]),
          rendererKey: z.string().min(1).optional(),
          reason: z.string().min(1).optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((plan, ctx) => {
    try {
      validateIonClonePlan(plan);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: String((error as Error).message ?? error),
      });
    }
  });

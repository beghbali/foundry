import { writeStageMarkdown } from "@foundry/core/artifacts";
import { StageInputCompositionSchema } from "@foundry/core/stageInputs";
import { z } from "zod";
// ---------- Zod hints for upstream outputs ----------
const RepoHintSchema = z.object({
    summary: z.object({
        repoTypeGuess: z.enum(["expo_rn", "node", "python", "unknown"]).optional(),
        hasSupabase: z.boolean().optional(),
        hasExpo: z.boolean().optional(),
    }).optional(),
    detected: z.object({
        mobileAppDir: z.string().optional(),
        supabaseDir: z.string().optional(),
    }).optional(),
});
const AuditHintSchema = z.object({
    detectedApp: z.object({
        mobileRoot: z.string().optional(),
        backendRoot: z.string().optional(),
        language: z.enum(["ts", "js", "mixed"]).optional(),
    }).optional(),
    navigation: z.object({
        navigators: z.array(z.object({
            file: z.string(),
            kind: z.enum(["stack", "tabs", "unknown"]),
        })).optional(),
    }).optional(),
    screens: z.array(z.object({
        name: z.string(),
        file: z.string(),
        purposeGuess: z.string(),
        keyActions: z.array(z.string()),
    })).optional(),
    dataModel: z.object({
        tablesMentioned: z.array(z.string()).optional(),
    }).optional(),
});
// ---------- output schema ----------
const PlanBlockSchema = z.object({
    approach: z.string(),
    files: z.array(z.string()),
    deps: z.array(z.string()).optional().default([]),
    acceptance: z.array(z.string()),
});
export const BaselineAppShellOutputSchema = z.object({
    applicable: z.boolean(),
    detected: z.object({
        mobileRoot: z.string().optional(),
        navFile: z.string().optional(),
        menuFile: z.string().optional(),
        authPresent: z.boolean().optional(),
        supabasePresent: z.boolean().optional(),
    }),
    plan: z.object({
        feedback: PlanBlockSchema,
        auth: PlanBlockSchema,
        progressiveProfiling: PlanBlockSchema,
    }),
    notes: z.array(z.string()),
});
function detect(input) {
    const repo = RepoHintSchema.safeParse(input.repoInventory);
    const audit = AuditHintSchema.safeParse(input.currentStateAudit);
    const mobileRoot = audit.success ? audit.data.detectedApp?.mobileRoot :
        repo.success ? repo.data.detected?.mobileAppDir : undefined;
    const supabasePresent = (repo.success && repo.data.summary?.hasSupabase === true) ||
        (audit.success && !!audit.data.detectedApp?.backendRoot);
    const navigators = audit.success ? (audit.data.navigation?.navigators ?? []) : [];
    const screens = audit.success ? (audit.data.screens ?? []) : [];
    const tables = audit.success ? (audit.data.dataModel?.tablesMentioned ?? []) : [];
    const tabsNav = navigators.find((n) => n.kind === "tabs");
    const rootNav = navigators.find((n) => n.kind === "stack" && /_layout/.test(n.file) && !n.file.includes("(tabs)") && !n.file.includes("onboarding"));
    const authScreen = screens.find((s) => /auth/i.test(s.purposeGuess));
    const settingsScreen = screens.find((s) => /settings/i.test(s.purposeGuess));
    const language = audit.success ? (audit.data.detectedApp?.language ?? "ts") : "ts";
    return {
        mobileRoot: mobileRoot ?? undefined,
        navFile: rootNav?.file,
        menuFile: tabsNav?.file ?? settingsScreen?.file,
        authPresent: !!authScreen,
        supabasePresent,
        language,
        hasFeedbackTable: tables.includes("feedback"),
        tabsLayout: tabsNav?.file,
        rootLayout: rootNav?.file,
        authScreen: authScreen?.file,
        settingsScreen: settingsScreen?.file,
    };
}
// ---------- plan builders ----------
function feedbackPlan(d, projectName) {
    const root = d.mobileRoot === "." ? "" : (d.mobileRoot ?? "") + "/";
    const ext = d.language === "js" ? "js" : "ts";
    const extx = d.language === "js" ? "jsx" : "tsx";
    const files = [
        `${root}src/components/feedback/FeedbackModal.${extx}`,
        `${root}src/hooks/useShakeToReport.${ext}`,
        `${root}src/lib/feedbackApi.${ext}`,
        `${root}src/types/feedback.${ext}`,
    ];
    if (d.tabsLayout)
        files.push(d.tabsLayout);
    if (d.rootLayout)
        files.push(d.rootLayout);
    const deps = ["expo-sensors"];
    if (d.supabasePresent && !d.hasFeedbackTable) {
        files.push(`supabase/migrations/xxx_feedback_table.sql`);
    }
    return {
        approach: [
            `Add a FeedbackModal component and useShakeToReport hook to ${projectName}.`,
            d.tabsLayout
                ? `Wrap existing tab buttons in ${d.tabsLayout} with onLongPress to open the feedback modal with the current tab name as context.`
                : "Add a global FeedbackProvider at the root layout level.",
            "Register the shake listener in the root layout so feedback is available from any screen.",
            d.supabasePresent
                ? "Submit feedback via Supabase `feedback` table insert (or edge function)."
                : "Submit feedback to a configurable API endpoint.",
        ].join(" "),
        files,
        deps,
        acceptance: [
            "Shaking the device from any screen opens the feedback modal.",
            "Long-pressing a tab opens the feedback modal with the tab name as context.",
            "Submitting feedback stores it in the backend with user ID, screen context, and timestamp.",
            "Empty messages cannot be submitted.",
            "The modal dismisses cleanly on cancel or successful submit.",
        ],
    };
}
function authPlan(d, projectName) {
    const root = d.mobileRoot === "." ? "" : (d.mobileRoot ?? "") + "/";
    const ext = d.language === "js" ? "js" : "ts";
    const extx = d.language === "js" ? "jsx" : "tsx";
    if (d.authPresent) {
        return {
            approach: [
                `Auth is already present in ${projectName} (detected at ${d.authScreen ?? "auth screen"}).`,
                "No new auth scaffolding needed.",
                "Consider adding social sign-in (Apple/Google) if only email is implemented.",
                d.supabasePresent
                    ? "Supabase Auth is available — use `supabase.auth.signInWithOAuth()` for social providers."
                    : "Add OAuth provider integration to the existing auth flow.",
            ].join(" "),
            files: d.authScreen ? [d.authScreen] : [],
            deps: [],
            acceptance: [
                "Existing auth flow continues to work.",
                "Social sign-in buttons appear on the sign-in screen (if added).",
                "Auth state is persisted across app restarts.",
            ],
        };
    }
    const files = [
        `${root}src/components/auth/AuthGate.${extx}`,
        `${root}src/screens/SignInScreen.${extx}`,
        `${root}src/lib/authClient.${ext}`,
    ];
    if (d.rootLayout)
        files.push(d.rootLayout);
    return {
        approach: [
            `Add authentication to ${projectName} using ${d.supabasePresent ? "Supabase Auth" : "a configurable auth provider"}.`,
            "Create an AuthGate component that wraps the app tree and shows SignInScreen when unauthenticated.",
            "SignInScreen supports email magic link by default, with optional Apple and Google sign-in.",
            d.rootLayout
                ? `Integrate AuthGate in ${d.rootLayout} around the existing Stack navigator.`
                : "Integrate AuthGate at the root of the app.",
        ].join(" "),
        files,
        deps: d.supabasePresent ? [] : ["@supabase/supabase-js"],
        acceptance: [
            "Unauthenticated users see the sign-in screen instead of the app.",
            "Email magic link sends successfully and signs the user in on tap.",
            "Auth state persists across app restarts.",
            "Sign-out from settings clears the session and returns to sign-in.",
        ],
    };
}
function profilingPlan(d, projectName) {
    const root = d.mobileRoot === "." ? "" : (d.mobileRoot ?? "") + "/";
    const ext = d.language === "js" ? "js" : "ts";
    const extx = d.language === "js" ? "jsx" : "tsx";
    const files = [
        `${root}src/stores/profileStore.${ext}`,
        `${root}src/components/profiling/ProfilePrompt.${extx}`,
    ];
    if (d.settingsScreen)
        files.push(d.settingsScreen);
    return {
        approach: [
            `Implement progressive profiling in ${projectName}: collect user preferences and conditions gradually, not on first open.`,
            "Create a profileStore (Zustand or equivalent) that tracks which profile fields have been collected and when the last prompt was shown.",
            "After the user completes their first successful session (e.g., first weekly check-in, first diagnosis), surface a non-blocking ProfilePrompt card.",
            "Each prompt asks one question (e.g., experience level, garden type, notification preferences).",
            "Never show more than one profiling prompt per session. Delay at least 24 hours between prompts.",
            d.settingsScreen
                ? `Collected preferences should also be editable from ${d.settingsScreen}.`
                : "Collected preferences should be editable from a settings screen.",
        ].join(" "),
        files,
        deps: [],
        acceptance: [
            "No profiling prompts appear during the user's first session.",
            "After the first successful action, a single non-blocking prompt appears.",
            "At most one prompt per session, with 24-hour cooldown between prompts.",
            "Users can skip prompts without consequence.",
            "All collected preferences are editable from settings.",
            "Profile completeness increases over time without feeling intrusive.",
        ],
    };
}
// ---------- README builder ----------
function buildReadme(output, projectName, templateRoot) {
    if (!output.applicable) {
        return [
            `# ${projectName} — Baseline App Shell`,
            "",
            "**Not applicable:** This stage only applies to Expo React Native projects.",
            "",
            ...output.notes.map((n) => `- ${n}`),
            "",
        ].join("\n");
    }
    const lines = [
        `# ${projectName} — Baseline App Shell`,
        "",
        "This plan adds three foundational capabilities to the app: **feedback capture**, **authentication**, and **progressive profiling**.",
        "",
        "## Detected",
        "",
        `- Mobile root: \`${output.detected.mobileRoot ?? "(root)"}\``,
        `- Navigation file: \`${output.detected.navFile ?? "(not found)"}\``,
        `- Tab/menu file: \`${output.detected.menuFile ?? "(not found)"}\``,
        `- Auth present: ${output.detected.authPresent ? "yes" : "no"}`,
        `- Supabase: ${output.detected.supabasePresent ? "yes" : "no"}`,
        "",
        "---",
        "",
        "## A) Feedback Capture",
        "",
        `**Approach:** ${output.plan.feedback.approach}`,
        "",
        "**Files to create/modify:**",
        ...output.plan.feedback.files.map((f) => `- \`${f}\``),
        "",
    ];
    if (output.plan.feedback.deps.length > 0) {
        lines.push("**Dependencies:**", ...output.plan.feedback.deps.map((d) => `- \`${d}\``), "");
    }
    lines.push("**Templates** (copy from foundry and adapt):", `- \`${templateRoot}/feedback/FeedbackModal.tsx\``, `- \`${templateRoot}/feedback/useShakeToReport.ts\``, `- \`${templateRoot}/feedback/feedbackApi.ts\``, `- \`${templateRoot}/feedback/types.ts\``, "", "**Acceptance criteria:**", ...output.plan.feedback.acceptance.map((a) => `- [ ] ${a}`), "", "---", "", "## B) Authentication", "", `**Approach:** ${output.plan.auth.approach}`, "", "**Files to create/modify:**", ...output.plan.auth.files.map((f) => `- \`${f}\``), "");
    if (output.plan.auth.deps.length > 0) {
        lines.push("**Dependencies:**", ...output.plan.auth.deps.map((d) => `- \`${d}\``), "");
    }
    lines.push("**Templates:**", `- \`${templateRoot}/auth/AuthGate.tsx\``, `- \`${templateRoot}/auth/SignInScreen.tsx\``, `- \`${templateRoot}/auth/authClient.ts\``, "", "**Acceptance criteria:**", ...output.plan.auth.acceptance.map((a) => `- [ ] ${a}`), "", "---", "", "## C) Progressive Profiling", "", `**Approach:** ${output.plan.progressiveProfiling.approach}`, "", "**Files to create/modify:**", ...output.plan.progressiveProfiling.files.map((f) => `- \`${f}\``), "", "**Acceptance criteria:**", ...output.plan.progressiveProfiling.acceptance.map((a) => `- [ ] ${a}`), "");
    if (output.notes.length > 0) {
        lines.push("---", "", "## Notes", "", ...output.notes.map((n) => `- ${n}`), "");
    }
    return lines.join("\n");
}
// ---------- stage ----------
export const baselineAppShellStage = {
    name: "baseline_app_shell",
    description: "Generate a project-specific implementation plan for feedback capture, authentication, and progressive profiling in an Expo RN app.",
    inputSchema: StageInputCompositionSchema,
    outputSchema: BaselineAppShellOutputSchema,
    async run(ctx, input) {
        const projectName = input.config.project.project_name;
        const d = detect(input);
        ctx.logger("[baseline_app_shell] analyzing", {
            project: projectName,
            mobileRoot: d.mobileRoot,
            authPresent: d.authPresent,
            supabasePresent: d.supabasePresent,
        });
        const repo = RepoHintSchema.safeParse(input.repoInventory);
        const isExpo = (repo.success && repo.data.summary?.hasExpo === true) ||
            (repo.success && repo.data.summary?.repoTypeGuess === "expo_rn") ||
            !!d.mobileRoot;
        if (!isExpo) {
            const output = {
                applicable: false,
                detected: {
                    mobileRoot: d.mobileRoot,
                    authPresent: d.authPresent,
                    supabasePresent: d.supabasePresent,
                },
                plan: {
                    feedback: { approach: "Not applicable — no Expo RN project detected.", files: [], deps: [], acceptance: [] },
                    auth: { approach: "Not applicable — no Expo RN project detected.", files: [], deps: [], acceptance: [] },
                    progressiveProfiling: { approach: "Not applicable — no Expo RN project detected.", files: [], deps: [], acceptance: [] },
                },
                notes: [
                    "This stage only applies to Expo React Native projects.",
                    `Detected repo type: ${repo.success ? (repo.data.summary?.repoTypeGuess ?? "unknown") : "unknown"}.`,
                ],
            };
            const validated = BaselineAppShellOutputSchema.parse(output);
            await writeStageMarkdown(ctx, "baseline_app_shell", "README.md", buildReadme(validated, projectName, "packages/templates/expo"));
            return validated;
        }
        const applyFlag = input.config.project.foundry;
        const shouldApply = typeof applyFlag === "object" &&
            applyFlag !== null &&
            applyFlag.apply_baseline_shell === true;
        const notes = [];
        if (shouldApply) {
            notes.push("apply_baseline_shell is true — builder stage may auto-apply templates.");
        }
        else {
            notes.push("apply_baseline_shell is false or unset — this stage produces a plan only. Set `foundry.apply_baseline_shell: true` in project.yaml to enable auto-apply.");
        }
        if (d.hasFeedbackTable) {
            notes.push("Existing `feedback` table detected in migrations. The feedbackApi template should use the existing table schema.");
        }
        if (d.authPresent) {
            notes.push(`Auth screen already exists at ${d.authScreen ?? "detected location"}. Focus on adding social providers rather than new auth scaffolding.`);
        }
        const output = {
            applicable: true,
            detected: {
                mobileRoot: d.mobileRoot,
                navFile: d.navFile,
                menuFile: d.menuFile,
                authPresent: d.authPresent,
                supabasePresent: d.supabasePresent,
            },
            plan: {
                feedback: feedbackPlan(d, projectName),
                auth: authPlan(d, projectName),
                progressiveProfiling: profilingPlan(d, projectName),
            },
            notes,
        };
        const validated = BaselineAppShellOutputSchema.parse(output);
        await writeStageMarkdown(ctx, "baseline_app_shell", "README.md", buildReadme(validated, projectName, "packages/templates/expo"));
        return validated;
    },
};

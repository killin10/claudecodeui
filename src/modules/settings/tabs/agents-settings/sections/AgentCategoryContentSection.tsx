import type { AgentCategory, AgentContextByProvider, AgentProvider, AgentSettingsProject, ClaudePermissionsState, CodexPermissionMode, CursorPermissionsState, SkillsProject } from '@/shared/types';
import { ProviderSkills } from '@/modules/skills';
import AccountContent from '@/modules/settings/tabs/agents-settings/sections/content/AccountContent';
import PermissionsContent from '@/modules/settings/tabs/agents-settings/sections/content/PermissionsContent';

type AgentCategoryContentSectionProps = {
  selectedAgent: AgentProvider;
  selectedCategory: AgentCategory;
  agentContextById: AgentContextByProvider;
  claudePermissions: ClaudePermissionsState;
  onClaudePermissionsChange: (value: ClaudePermissionsState) => void;
  cursorPermissions: CursorPermissionsState;
  onCursorPermissionsChange: (value: CursorPermissionsState) => void;
  codexPermissionMode: CodexPermissionMode;
  onCodexPermissionModeChange: (value: CodexPermissionMode) => void;
  projects: AgentSettingsProject[];
};

/** Rendered by AgentsSettingsTab to show the panel for the selected provider and category. */
export default function AgentCategoryContentSection({
  selectedAgent,
  selectedCategory,
  agentContextById,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  projects,
}: AgentCategoryContentSectionProps) {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-3 md:p-4">
      {selectedCategory === 'account' && (
        <AccountContent
          agent={selectedAgent}
          authStatus={agentContextById[selectedAgent].authStatus}
          onLogin={agentContextById[selectedAgent].onLogin}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'claude' && (
        <PermissionsContent
          agent="claude"
          skipPermissions={claudePermissions.skipPermissions}
          onSkipPermissionsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, skipPermissions: value });
          }}
          allowedTools={claudePermissions.allowedTools}
          onAllowedToolsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, allowedTools: value });
          }}
          disallowedTools={claudePermissions.disallowedTools}
          onDisallowedToolsChange={(value) => {
            onClaudePermissionsChange({ ...claudePermissions, disallowedTools: value });
          }}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'cursor' && (
        <PermissionsContent
          agent="cursor"
          skipPermissions={cursorPermissions.skipPermissions}
          onSkipPermissionsChange={(value) => {
            onCursorPermissionsChange({ ...cursorPermissions, skipPermissions: value });
          }}
          allowedCommands={cursorPermissions.allowedCommands}
          onAllowedCommandsChange={(value) => {
            onCursorPermissionsChange({ ...cursorPermissions, allowedCommands: value });
          }}
          disallowedCommands={cursorPermissions.disallowedCommands}
          onDisallowedCommandsChange={(value) => {
            onCursorPermissionsChange({ ...cursorPermissions, disallowedCommands: value });
          }}
        />
      )}

      {selectedCategory === 'permissions' && selectedAgent === 'codex' && (
        <PermissionsContent
          agent="codex"
          permissionMode={codexPermissionMode}
          onPermissionModeChange={onCodexPermissionModeChange}
        />
      )}

      {selectedCategory === 'skills' && selectedAgent !== 'opencode' && (
        <ProviderSkills
          selectedProvider={selectedAgent}
          currentProjects={projects.map<SkillsProject>((project) => ({
            projectId: project.name,
            displayName: project.displayName,
            fullPath: project.fullPath,
            path: project.path,
          }))}
        />
      )}
    </div>
  );
}

// Plugin management API (v3.0 plugin platform).
//
// Lists the plugins registered in this build and lets a user activate/deactivate each for
// themselves. Activation is per-user (users.preferences.enabledPlugins) and independent of a
// plugin's own per-account config. Toggling fires the generic `onPluginActivationChanged` hook so
// the affected plugin can react (GTD drops its cached config so the change takes effect at once) —
// core never calls a plugin directly.
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pluginRegistry } from '../plugins/registry.js';
import { getActivatedPlugins, setPluginActivated } from '../plugins/activation.js';

const router = Router();
router.use(requireAuth);

// The user-facing view of a registered plugin. Deliberately minimal — no handlers/hooks/router.
function publicManifest(plugin, activated) {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    tier: plugin.tier,
    activated,
  };
}

// GET /api/plugins — every registered plugin plus whether this user has it activated.
router.get('/', async (req, res) => {
  const activated = await getActivatedPlugins(req.session.userId);
  res.json(pluginRegistry.list().map((p) => publicManifest(p, activated.has(p.id))));
});

// PATCH /api/plugins/:id — activate/deactivate a plugin for the current user. Body: { activated }.
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  if (!pluginRegistry.has(id)) return res.status(404).json({ error: 'Unknown plugin' });
  if (typeof req.body?.activated !== 'boolean') {
    return res.status(400).json({ error: 'activated (boolean) is required' });
  }
  const activated = req.body.activated;
  await setPluginActivated(req.session.userId, id, activated);

  // Let the plugin react to its activation change (e.g. GTD invalidates its per-account config
  // cache for this user so the effective gate flips immediately). Errors are swallowed per-plugin.
  await pluginRegistry.runHook('onPluginActivationChanged', {
    userId: req.session.userId, pluginId: id, activated,
  });

  res.json({ id, activated });
});

export default router;

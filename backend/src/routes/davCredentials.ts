import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  createDavAppPassword,
  listDavAppPasswords,
  revokeDavAppPassword,
} from '../services/davAppPasswords.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const credentials = await listDavAppPasswords(req.session.userId);
  res.json({ credentials });
});

router.post('/', async (req, res) => {
  try {
    const created = await createDavAppPassword(req.session.userId, req.body?.label);
    const { secret, ...credential } = created;
    res.status(201).json({ credential, secret });
  } catch (err) {
    if (err.message === 'A device label between 1 and 120 characters is required') {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

router.delete('/:id', async (req, res) => {
  const credential = await revokeDavAppPassword(req.session.userId, req.params.id);
  if (!credential) return res.status(404).json({ error: 'DAV application password not found' });
  res.json({ credential });
});

export default router;

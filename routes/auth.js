import express from 'express';

const router = express.Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (
    email === process.env.ADMIN_EMAIL &&
    password === process.env.ADMIN_PASSWORD
  ) {
    req.session.user = 'superadmin';
    return res.json({ success: true });
  }

  return res.status(401).json({ error: 'Invalid credentials' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

export default router;

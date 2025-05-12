import express from 'express';
import session from 'express-session';
import dotenv from 'dotenv';

import authRouter from './routes/auth.js';
import projectsRouter from './routes/projects.js';
import categoriesRouter from './routes/categories.js';

dotenv.config();

const app = express();
app.use(express.json());

// ✅ Session setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set true if using HTTPS
    httpOnly: true,
    maxAge: 1000 * 60 * 60 // 1 hour
  }
}));

// ✅ Middleware to protect routes
function isAuthenticated(req, res, next) {
  if (req.session?.user === 'superadmin') {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// ✅ Public routes
app.use('/api/auth', authRouter);

// ✅ Protected routes
app.use('/api/projects', isAuthenticated, projectsRouter);
app.use('/api/categories', isAuthenticated, categoriesRouter);

// ✅ Root
app.get('/', (req, res) => {
  res.send('HSArchitect API is running.');
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

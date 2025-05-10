import express from 'express';
import dotenv from 'dotenv';

import projectsRouter from './routes/projects.js';
import categoriesRouter from './routes/categories.js';

dotenv.config();

const app = express();
app.use(express.json());

app.use('/api/projects', projectsRouter);
app.use('/api/categories', categoriesRouter);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

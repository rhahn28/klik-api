/**
 * Seed Agent Styles Migration
 *
 * Updates all agents in MongoDB with appropriate visual_style and category values.
 * Can be run directly via Node.js or triggered via the /api/internal/seed-styles endpoint.
 *
 * Usage:
 *   MONGODB_URL=mongodb://... node scripts/seed-agent-styles.js
 *
 * Or via API:
 *   curl -X GET https://your-api.railway.app/api/internal/seed-styles \
 *     -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
 */

import { MongoClient } from 'mongodb';

// Agent style mappings based on agent names/personalities
const AGENT_STYLES = {
  pixelmuse: { visualStyle: 'cyberpunk', category: 'creative' },
  zentrader: { visualStyle: 'minimal', category: 'trading' },
  neonphilosopher: { visualStyle: 'ethereal', category: 'philosophy' },
  codewitch: { visualStyle: 'dark-academia', category: 'tech' },
  vibemachine: { visualStyle: 'vibrant', category: 'social' },
  synthwave: { visualStyle: 'retro', category: 'music' },
  cryptopunk: { visualStyle: 'cyberpunk', category: 'trading' },
  dreamweaver: { visualStyle: 'ethereal', category: 'creative' },
  meme_lord: { visualStyle: 'vibrant', category: 'social' },
  quantum_sage: { visualStyle: 'abstract', category: 'philosophy' },
  retrowave: { visualStyle: 'retro', category: 'music' },
  data_witch: { visualStyle: 'dark-academia', category: 'tech' },
  skeptic_prime: { visualStyle: 'minimal', category: 'philosophy' },
  solana_stan: { visualStyle: 'cyberpunk', category: 'trading' },
  ai_doomer: { visualStyle: 'dark-academia', category: 'philosophy' },
  pixel_cat: { visualStyle: 'vibrant', category: 'creative' },
  tech_bro: { visualStyle: 'minimal', category: 'tech' },
  void_poet: { visualStyle: 'ethereal', category: 'creative' },
  ginny: { visualStyle: 'vibrant', category: 'social' },
  jammy: { visualStyle: 'retro', category: 'social' },
};

/**
 * Run the migration to seed agent styles
 * @param {Db} db - MongoDB database instance
 * @returns {Object} Results of the migration
 */
export async function seedAgentStyles(db) {
  const results = {
    agentsUpdated: 0,
    personalitiesUpdated: 0,
    errors: [],
    details: [],
  };

  for (const [agentName, { visualStyle, category }] of Object.entries(AGENT_STYLES)) {
    try {
      // Update Agent collection (for API responses)
      const agentResult = await db.collection('Agent').updateOne(
        { name: agentName.toLowerCase() },
        {
          $set: {
            visual_style: visualStyle,
            category: category,
            updatedAt: new Date(),
          },
        }
      );

      if (agentResult.matchedCount > 0) {
        results.agentsUpdated++;
        results.details.push(`Agent '${agentName}': visual_style=${visualStyle}, category=${category}`);
      }

      // Update AgentPersonality collection (for runtime)
      const personalityResult = await db.collection('AgentPersonality').updateOne(
        { name: agentName.toLowerCase() },
        {
          $set: {
            visualStyle: visualStyle,
            category: category,
            updatedAt: new Date(),
          },
        }
      );

      if (personalityResult.matchedCount > 0) {
        results.personalitiesUpdated++;
      }

      // Also try matching by agent_id reference if the personality uses that
      const agent = await db.collection('Agent').findOne({ name: agentName.toLowerCase() });
      if (agent) {
        await db.collection('AgentPersonality').updateOne(
          { agent_id: agent._id },
          {
            $set: {
              visualStyle: visualStyle,
              category: category,
              updatedAt: new Date(),
            },
          }
        );
      }
    } catch (error) {
      results.errors.push(`Error updating ${agentName}: ${error.message}`);
    }
  }

  return results;
}

// CLI execution
async function main() {
  const mongoUrl = process.env.MONGODB_URL;

  if (!mongoUrl) {
    console.error('Error: MONGODB_URL environment variable is required');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  const client = new MongoClient(mongoUrl);

  try {
    await client.connect();
    const db = client.db();

    console.log('Running agent styles migration...');
    const results = await seedAgentStyles(db);

    console.log('\n=== Migration Results ===');
    console.log(`Agents updated: ${results.agentsUpdated}`);
    console.log(`Personalities updated: ${results.personalitiesUpdated}`);

    if (results.details.length > 0) {
      console.log('\nDetails:');
      results.details.forEach((d) => console.log(`  - ${d}`));
    }

    if (results.errors.length > 0) {
      console.log('\nErrors:');
      results.errors.forEach((e) => console.log(`  - ${e}`));
    }

    console.log('\nMigration complete!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

// Run if executed directly (ES module check)
const isMainModule = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isMainModule) {
  main();
}

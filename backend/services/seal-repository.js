export const sealSchema = [
  `CREATE TABLE IF NOT EXISTS seal_reference_group (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    label VARCHAR(128) COLLATE utf8mb4_bin NOT NULL UNIQUE,
    seal_name VARCHAR(255) NOT NULL, company_name VARCHAR(255) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'active', sample_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) CHARACTER SET utf8mb4`,
  `CREATE TABLE IF NOT EXISTS seal_reference_sample (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, group_id BIGINT UNSIGNED NOT NULL,
    source_file_name VARCHAR(512) NOT NULL, source_sha256 CHAR(64) NOT NULL, crop_sha256 CHAR(64) NOT NULL,
    source_path VARCHAR(1024) NOT NULL, image_path VARCHAR(1024) NOT NULL,
    page_number INT UNSIGNED NOT NULL, bbox JSON NOT NULL, roi_sha256 CHAR(64) NOT NULL,
    quality_score DECIMAL(5,2) NOT NULL, quality_metrics JSON NOT NULL,
    feature_count INT UNSIGNED NOT NULL, processing_version VARCHAR(64) NOT NULL,
    confirmation_status VARCHAR(24) NOT NULL DEFAULT 'confirmed', confirmed_at DATETIME(3) NOT NULL,
    provenance JSON NOT NULL, created_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY idx_seal_roi (source_sha256, page_number, roi_sha256),
    UNIQUE KEY idx_seal_crop (crop_sha256),
    INDEX idx_seal_group (group_id, confirmation_status),
    CONSTRAINT fk_seal_group FOREIGN KEY (group_id) REFERENCES seal_reference_group(id)
  ) CHARACTER SET utf8mb4`
]

export function sealRepository(pool) {
  return {
    async groups() {
      const [rows] = await pool.query(`SELECT g.*, COUNT(s.id) AS sample_count,
        COUNT(DISTINCT s.source_sha256) AS independent_sources FROM seal_reference_group g
        LEFT JOIN seal_reference_sample s ON s.group_id=g.id AND s.confirmation_status='confirmed'
        GROUP BY g.id ORDER BY g.id DESC`)
      return rows
    },
    async createGroup({ label, sealName, companyName }) {
      const [result] = await pool.execute('INSERT INTO seal_reference_group (label,seal_name,company_name) VALUES (?,?,?)', [label,sealName,companyName])
      return { id: result.insertId }
    },
    async samples(groupId) {
      const [rows] = await pool.execute(`SELECT id,group_id,source_file_name,page_number,quality_score,feature_count,confirmation_status,created_time FROM seal_reference_sample WHERE group_id=? ORDER BY id DESC`, [groupId])
      return rows
    },
    async sample(id) {
      const [rows] = await pool.execute('SELECT * FROM seal_reference_sample WHERE id=?', [id])
      return rows[0]
    },
    async insertSample(data) {
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const [groups] = await connection.execute("SELECT id FROM seal_reference_group WHERE id=? AND status='active' FOR UPDATE", [data.groupId])
        if (!groups.length) throw Object.assign(new Error('印章身份不存在或已停用。'), { status:404 })
        const [result] = await connection.execute(`INSERT INTO seal_reference_sample
          (group_id,source_file_name,source_sha256,crop_sha256,source_path,image_path,page_number,bbox,roi_sha256,
           quality_score,quality_metrics,feature_count,processing_version,confirmed_at,provenance)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(3),?)`,
        [data.groupId,data.fileName,data.sourceHash,data.cropHash,data.sourcePath,data.imagePath,data.page,
          JSON.stringify(data.bbox),data.roiHash,data.qualityScore,JSON.stringify(data.qualityMetrics),data.featureCount,
          data.processingVersion,JSON.stringify({method:'explicit_human_confirmation',channel:data.channel})])
        await connection.execute('UPDATE seal_reference_group SET sample_version=sample_version+1 WHERE id=?', [data.groupId])
        await connection.commit()
        return {id:result.insertId}
      } catch(error) { await connection.rollback(); throw error }
      finally { connection.release() }
    },
    async deactivate(id) {
      const c = await pool.getConnection()
      try {
        await c.beginTransaction()
        const [rows] = await c.execute('SELECT group_id FROM seal_reference_sample WHERE id=? FOR UPDATE',[id])
        if (!rows.length) throw Object.assign(new Error('样本不存在。'), {status:404})
        await c.execute("UPDATE seal_reference_sample SET confirmation_status='disabled' WHERE id=?",[id])
        await c.execute('UPDATE seal_reference_group SET sample_version=sample_version+1 WHERE id=?',[rows[0].group_id])
        await c.commit()
      } catch(e) { await c.rollback(); throw e } finally { c.release() }
    },
    async updateFeatures(groupId,samples){
      const c=await pool.getConnection()
      try{
        await c.beginTransaction()
        await c.execute('SELECT id FROM seal_reference_group WHERE id=? FOR UPDATE',[groupId])
        for(const s of samples)await c.execute('UPDATE seal_reference_sample SET quality_score=?,quality_metrics=?,feature_count=?,processing_version=? WHERE id=? AND group_id=?',
          [s.qualityScore,JSON.stringify(s.qualityMetrics),s.featureCount,s.processingVersion,s.id,groupId])
        await c.execute('UPDATE seal_reference_group SET sample_version=sample_version+1 WHERE id=?',[groupId])
        await c.commit()
      }catch(e){await c.rollback();throw e}finally{c.release()}
    },
    async library() {
      const [rows] = await pool.query(`SELECT s.id,s.group_id,s.source_sha256,s.image_path,g.label,g.seal_name,g.company_name
        FROM seal_reference_sample s JOIN seal_reference_group g ON g.id=s.group_id
        WHERE s.confirmation_status='confirmed' AND g.status='active' ORDER BY s.id LIMIT 5001`)
      if(rows.length>5000) throw Object.assign(new Error('参考库超过当前 5000 样本容量，请分库处理。'),{status:422})
      const groups = new Map()
      for (const row of rows) {
        if(!groups.has(row.group_id)) groups.set(row.group_id,{id:row.group_id,label:row.label,sealName:row.seal_name,companyName:row.company_name,samples:[]})
        groups.get(row.group_id).samples.push({id:row.id,sourceHash:row.source_sha256,path:row.image_path})
      }
      return [...groups.values()]
    }
  }
}

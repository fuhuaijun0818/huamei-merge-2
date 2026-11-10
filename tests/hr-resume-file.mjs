import assert from "node:assert/strict";
import JSZip from "jszip";
import { extractResumeAttachment } from "../server/hr-resume-file.mjs";

process.env.HUAMEI_HR_STORE_FILE = ":memory:";
const hr = await import("../server/hr-operations.mjs");

const base64 = (buffer) => Buffer.from(buffer).toString("base64");
const assertCode = async (promise, code) => {
  await assert.rejects(promise, (error) => error.code === code);
};

const text = await extractResumeAttachment({
  file_name:"候选人简历.txt",
  mime_type:"text/plain",
  data_base64:base64(Buffer.from("\uFEFF本人有6年招聘与员工关系经验，熟悉Excel、飞书和人力资源流程。", "utf8"))
});
assert.equal(text.parser, "utf8-text");
assert.equal(text.file_name, "候选人简历.txt");
assert.match(text.text, /招聘/);

const docx = new JSZip();
docx.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>5年招聘与绩效经验</w:t></w:r></w:p>
<w:p><w:r><w:t>熟悉Excel、飞书和数据分析</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>沟通能力良好</w:t></w:r></w:p>
</w:body></w:document>`);
const docxBuffer = await docx.generateAsync({ type:"nodebuffer" });
const docxResume = await extractResumeAttachment({
  file_name:"候选人简历.docx",
  mime_type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  data_base64:base64(docxBuffer)
});
assert.equal(docxResume.parser, "docx-xml");
assert.match(docxResume.text, /招聘与绩效/);
assert.match(docxResume.text, /数据分析/);

const makePdf = (content) => {
  const stream = `BT /F1 12 Tf 72 720 Td (${content.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
};
const pdfResume = await extractResumeAttachment({
  file_name:"candidate.pdf",
  mime_type:"application/pdf",
  data_base64:base64(makePdf("Python SQL data analysis for 8 years with clear communication"))
});
assert.equal(pdfResume.parser, "pdf-parse");
assert.match(pdfResume.text, /Python SQL/);

const uploadPayload = {
  file_name:"candidate.pdf",
  mime_type:"application/pdf",
  data_base64:base64(makePdf("Python SQL data analysis for 8 years with clear communication"))
};
await assertCode(hr.screenResumeAttachment({
  tenantId:"tenant-hr-resume-file",
  actor:"hr-resume-test",
  payload:uploadPayload
}), "HR_RESUME_JOB_PROFILE_REQUIRED");
const profile = await hr.saveResumeJobProfile({
  tenantId:"tenant-hr-resume-file",
  actor:"hr-resume-test",
  payload:{
    job_title:"数据分析专员",
    job_description:"岗位职责：使用Python、SQL完成数据分析，要求5年以上经验并具备沟通能力。"
  }
});
assert.equal(profile.job_title, "数据分析专员");
assert.equal(profile.version, 1);
const screening = await hr.screenResumeAttachment({
  tenantId:"tenant-hr-resume-file",
  actor:"hr-resume-test",
  payload:uploadPayload
});
assert.equal(screening.source_type, "file");
assert.equal(screening.source_filename, "candidate.pdf");
assert.equal(screening.source_mime, "application/pdf");
assert.equal(screening.parser, "pdf-parse");
assert.equal(screening.job_title, "数据分析专员");
assert.equal(screening.job_profile_id, profile.id);
assert.equal(screening.job_profile_version, 1);
assert.equal(screening.candidate_label, "candidate");
assert.ok(screening.extracted_chars >= 20);
assert.ok(screening.matched_terms.includes("Python"));
assert.equal(screening.auto_reject, false);
assert.equal(Object.hasOwn(screening, "resume_text"), false);
assert.doesNotMatch(JSON.stringify(screening), /Python SQL data analysis for 8 years/);
const overview = await hr.getHrOverview({ tenantId:"tenant-hr-resume-file", actor:"hr-resume-test" });
assert.equal(overview.resumeJobProfile.job_title, "数据分析专员");
assert.equal(overview.resumeScreenings[0].job_title, "数据分析专员");

const secondProfile = await hr.saveResumeJobProfile({
  tenantId:"tenant-hr-resume-file",
  actor:"hr-resume-test",
  payload:{
    create_new:true,
    job_title:"人力运营负责人",
    department:"人力资源部",
    job_description:"岗位职责：负责招聘运营、员工关系和绩效项目，要求4年以上经验并具备跨部门沟通能力。"
  }
});
assert.notEqual(secondProfile.id, profile.id);
assert.equal(secondProfile.version, 1);
assert.equal(secondProfile.status, "active");
const secondScreening = await hr.screenResumeAttachment({
  tenantId:"tenant-hr-resume-file",
  actor:"hr-resume-test",
  payload:{ ...uploadPayload, job_profile_id:secondProfile.id }
});
assert.equal(secondScreening.job_profile_id, secondProfile.id);
assert.equal(secondScreening.job_title, "人力运营负责人");
assert.equal(secondScreening.job_department, "人力资源部");
assert.equal(secondScreening.job_profile_version, 1);
const multiJobOverview = await hr.getHrOverview({ tenantId:"tenant-hr-resume-file", actor:"hr-resume-test" });
assert.equal(multiJobOverview.resumeJobProfiles.length, 2);
assert.equal(multiJobOverview.resumeJobProfiles.filter((item) => item.status === "active").length, 2);
const batchScreening = await hr.screenResumeAttachmentForJobs({
  tenantId:"tenant-hr-resume-file",
  actor:"hr-resume-test",
  payload:{ ...uploadPayload, job_profile_ids:[profile.id, secondProfile.id] }
});
assert.equal(batchScreening.job_count, 2);
assert.equal(batchScreening.screenings.length, 2);
assert.deepEqual(new Set(batchScreening.screenings.map((item) => item.job_profile_id)), new Set([profile.id, secondProfile.id]));
assert.equal(new Set(batchScreening.screenings.map((item) => item.batch_id)).size, 1);
assert.equal(new Set(batchScreening.screenings.map((item) => item.resume_sha256)).size, 1);
assert.ok(batchScreening.screenings.every((item) => item.source_filename === "candidate.pdf" && !Object.hasOwn(item, "resume_text")));
await assertCode(hr.screenResumeAttachmentForJobs({
  tenantId:"tenant-hr-resume-file",
  actor:"hr-resume-test",
  payload:{ ...uploadPayload, job_profile_ids:[] }
}), "HR_RESUME_JOB_SELECTION_REQUIRED");

const inactiveProfile = await hr.saveResumeJobProfile({
  tenantId:"tenant-hr-resume-file",
  actor:"hr-resume-test",
  payload:{
    job_profile_id:secondProfile.id,
    job_title:"人力运营负责人",
    department:"人力资源部",
    status:"inactive",
    job_description:"岗位职责：负责招聘运营、员工关系和绩效项目，要求4年以上经验并具备跨部门沟通能力。"
  }
});
assert.equal(inactiveProfile.status, "inactive");
assert.equal(inactiveProfile.version, 2);
await assertCode(hr.screenResumeAttachment({
  tenantId:"tenant-hr-resume-file",
  actor:"hr-resume-test",
  payload:{ ...uploadPayload, job_profile_id:secondProfile.id }
}), "HR_RESUME_JOB_PROFILE_INACTIVE");
await assertCode(hr.screenResumeAttachmentForJobs({
  tenantId:"tenant-hr-resume-file",
  actor:"hr-resume-test",
  payload:{ ...uploadPayload, job_profile_ids:[profile.id, secondProfile.id] }
}), "HR_RESUME_JOB_PROFILE_INACTIVE");
const afterInactive = await hr.getHrOverview({ tenantId:"tenant-hr-resume-file", actor:"hr-resume-test" });
assert.equal(afterInactive.resumeJobProfiles.length, 2);
assert.equal(afterInactive.resumeJobProfile.id, profile.id, "停用当前岗位后应回退到仍启用的岗位");
await assertCode(hr.deleteResumeJobProfile({
  tenantId:"tenant-hr-resume-file",
  actor:"hr-resume-test",
  jobProfileId:profile.id
}), "HR_RESUME_JOB_PROFILE_ACTIVE");
const deletedJob = await hr.deleteResumeJobProfile({
  tenantId:"tenant-hr-resume-file",
  actor:"hr-resume-test",
  jobProfileId:secondProfile.id
});
assert.equal(deletedJob.id, secondProfile.id);
assert.equal(deletedJob.historical_screenings, 2);
const afterDelete = await hr.getHrOverview({ tenantId:"tenant-hr-resume-file", actor:"hr-resume-test" });
assert.equal(afterDelete.resumeJobProfiles.length, 1);
assert.equal(afterDelete.resumeJobProfiles[0].id, profile.id);
assert.equal(afterDelete.resumeScreenings.filter((item) => item.job_profile_id === secondProfile.id).length, 2, "删除岗位不能删除历史评分快照");
await assertCode(hr.deleteResumeJobProfile({
  tenantId:"tenant-hr-resume-file",
  actor:"hr-resume-test",
  jobProfileId:secondProfile.id
}), "HR_RESUME_JOB_PROFILE_NOT_FOUND");

await assertCode(extractResumeAttachment({
  file_name:"resume.exe",
  mime_type:"application/octet-stream",
  data_base64:base64("not a resume")
}), "HR_RESUME_FILE_TYPE_UNSUPPORTED");
await assertCode(extractResumeAttachment({
  file_name:"fake.pdf",
  mime_type:"application/pdf",
  data_base64:base64("not a pdf resume with enough text")
}), "HR_RESUME_FILE_SIGNATURE_INVALID");
await assertCode(extractResumeAttachment({
  file_name:"../escape.txt",
  mime_type:"text/plain",
  data_base64:"not-base64"
}), "HR_RESUME_FILE_INVALID");

console.log("hr-resume-file: passed");

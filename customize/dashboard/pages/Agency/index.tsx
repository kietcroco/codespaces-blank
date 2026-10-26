import { useCallback, useEffect, useState } from "react";
import { Button, Card, Col, Drawer, Empty, Row, Spin, Tabs, Tag } from "antd";
import { Building2, Plus } from "lucide-react";
import { message } from "@/utils/antdMessage";
import { request } from "../../api/request";
import PageShell from "../../layouts/PageShell";
import AgencyDetail from "./components/AgencyDetail";
import AgencyFormModal, { type AgencyRow } from "./components/AgencyFormModal";
import AgencyOrgChart from "./components/AgencyOrgChart";

export default function AgencyPage(): JSX.Element {
  const [agencies, setAgencies] = useState<AgencyRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [detailAgencyId, setDetailAgencyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await request<AgencyRow[]>("/agencies");
      setAgencies(rows);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load agencies");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setFormOpen(true);
  };

  const handleSaved = () => {
    setFormOpen(false);
    void load();
  };

  if (loading && agencies.length === 0) {
    return <Spin />;
  }

  const departmentsPane = (
    <>
      {agencies.length === 0 ? (
        <Empty description="No agencies yet" />
      ) : (
        <Row gutter={[16, 16]}>
          {agencies.map((agency) => (
            <Col key={agency.agency_id} xs={24} sm={12} md={8} lg={6}>
              <Card
                hoverable
                onClick={() => setDetailAgencyId(agency.agency_id)}
                title={
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Tag color={agency.color ?? undefined} style={{ margin: 0 }}>
                      <Building2 size={12} />
                    </Tag>
                    {agency.name}
                  </span>
                }
              >
                {agency.description && <p>{agency.description}</p>}
                <p>
                  {agency.member_count} expert{agency.member_count === 1 ? "" : "s"}
                </p>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </>
  );

  return (
    <PageShell.FillTabs
      title="Agencies"
      actions={
        <Button type="primary" icon={<Plus size={14} />} onClick={openCreate}>
          New Agency
        </Button>
      }
    >
      <Tabs
        defaultActiveKey="departments"
        items={[
          {
            key: "departments",
            label: "Agencies",
            children: departmentsPane,
          },
          {
            key: "org-chart",
            label: "Org Chart",
            children: <AgencyOrgChart />,
          },
        ]}
      />

      <AgencyFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={handleSaved}
      />

      <Drawer
        title="Agency detail"
        open={detailAgencyId != null}
        onClose={() => setDetailAgencyId(null)}
        width={480}
        destroyOnClose
      >
        {detailAgencyId != null && (
          <AgencyDetail
            agencyId={detailAgencyId}
            onDeleted={() => {
              setDetailAgencyId(null);
              void load();
            }}
          />
        )}
      </Drawer>
    </PageShell.FillTabs>
  );
}
